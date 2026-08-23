/**
 * SearXNG-backed web search provider for the `ctx.web` capability seam.
 *
 * Replaces the model-facing `web_search` backend (default: the DeepSeek native
 * search route) with a query against a SearXNG metasearch instance. The provider
 * is a plain static Node plugin, so unlike a dynamic Cordis package it may use
 * the global `fetch` to reach SearXNG. Results are normalized into the seam's
 * `WebSearchResult` shape (`sources[]` with url/title/snippet/publishedAt, plus
 * the optional `content` the tool renders ahead of the source list).
 *
 * @module @creait/dsh-web-search-searxng
 */

import z from '@deepseek-ai/schemastery';
import { WebError } from '@deepseek-ai/dsh-web';

/** Stable id this provider registers under in the search capability kind. */
const SEARXNG_PROVIDER_ID = 'searxng';

/**
 * Default SearXNG instance base URL: none.
 *
 * Empty is deliberate, and it is what lets this package ship a bundle patch. A
 * provider carrying a usable default comes up available the moment it is
 * installed, and `ctx.web` throws `WEB_PROVIDER_AMBIGUOUS` when two usable
 * search providers are registered and no `searchProvider` names one — so
 * installing this to see what it does would have broken the search that was
 * already working. Unconfigured, `available()` is false and the shipped
 * provider keeps serving. Set `baseURL` (no trailing slash; the
 * `searxng/searxng` image listens on http://localhost:8080) and the row wakes
 * up.
 */
const SEARXNG_DEFAULT_BASE_URL = '';

/** Default number of results requested from SearXNG. */
const SEARXNG_DEFAULT_MAX_RESULTS = 10;

/**
 * Default ceiling on result pages fetched for one search.
 *
 * SearXNG has no result-count parameter — `count` is silently ignored, and a
 * page holds whatever the engines returned (commonly 10, sometimes fewer once
 * duplicates collapse). Honouring `maxResults` therefore means paging, and the
 * cap bounds how many sequential upstream round-trips one tool call can cost.
 */
const SEARXNG_DEFAULT_MAX_PAGES = 3;

/** The freshness windows SearXNG's `time_range` accepts. */
const SEARXNG_TIME_RANGES = ['day', 'week', 'month', 'year'];

/** Attribution header sent on every request. */
const USER_AGENT = 'deepseek-harness/0.0.1 (searxng search)';

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === 'AbortError';
}

/** A non-empty trimmed string, or undefined for anything else. */
function text(value) {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Read SearXNG's `unresponsive_engines` into readable `engine (reason)` labels.
 *
 * The field is a list of `[engine, reason]` pairs, and it is the only signal
 * that a search covered less of the web than it looks like it did. Older builds
 * emit a bare string, so both shapes are accepted.
 *
 * @param body - the parsed SearXNG JSON response.
 * @returns one label per failed engine, in the order SearXNG reported them.
 */
function readUnresponsiveEngines(body) {
	const raw = Array.isArray(body?.unresponsive_engines) ? body.unresponsive_engines : [];
	const labels = [];
	for (const entry of raw) {
		if (typeof entry === 'string') {
			const name = text(entry);
			if (name !== undefined) labels.push(name);
			continue;
		}
		if (!Array.isArray(entry)) continue;
		const name = text(entry[0]);
		if (name === undefined) continue;
		const reason = text(entry[1]);
		labels.push(reason === undefined ? name : `${name} (${reason})`);
	}
	return labels;
}

/**
 * Collect the short free-text answers SearXNG resolved directly.
 *
 * Recent builds return `{ answer, url }` objects where older ones returned bare
 * strings; both carry the same thing, so both are read.
 *
 * @param body - the parsed SearXNG JSON response.
 * @returns the answer texts, deduped and in upstream order.
 */
function readAnswers(body) {
	const raw = Array.isArray(body?.answers) ? body.answers : [];
	const seen = new Set();
	const answers = [];
	for (const entry of raw) {
		const answer = typeof entry === 'string' ? text(entry) : text(entry?.answer);
		if (answer === undefined || seen.has(answer)) continue;
		seen.add(answer);
		answers.push(answer);
	}
	return answers;
}

/**
 * Collect the spelling corrections and query suggestions SearXNG offered.
 *
 * These only earn their tokens on a search that found nothing: they are the
 * difference between "the web has nothing" and "you spelled it wrong".
 *
 * @param body - the parsed SearXNG JSON response.
 * @returns the suggested queries, deduped, corrections first.
 */
function readSuggestions(body) {
	const seen = new Set();
	const out = [];
	for (const key of ['corrections', 'suggestions']) {
		const raw = Array.isArray(body?.[key]) ? body[key] : [];
		for (const entry of raw) {
			const value = typeof entry === 'string' ? text(entry) : text(entry?.title ?? entry?.url);
			if (value === undefined || seen.has(value)) continue;
			seen.add(value);
			out.push(value);
		}
	}
	return out;
}

/**
 * Map one SearXNG `/search?format=json` page onto the seam's source shape.
 *
 * SearXNG returns `{ results: [{ title, url, content, publishedDate, ... }] }`
 * plus engine diagnostics. Empty `results` is a legitimate no-hit outcome at
 * this level, not an error — {@link SearxngSearchProvider.search} is where an
 * empty page is weighed against engine health.
 *
 * @param body - the parsed SearXNG JSON response.
 * @returns the page's sources plus the envelope fields worth reporting.
 */
function mapSearxngResponse(body) {
	const raw = Array.isArray(body?.results) ? body.results : [];
	const seen = new Set();
	const sources = [];
	for (const item of raw) {
		if (item == null || typeof item !== 'object') continue;
		const url = typeof item.url === 'string' ? item.url : '';
		if (url.length === 0 || seen.has(url)) continue;
		seen.add(url);
		const title = typeof item.title === 'string' && item.title.length > 0 ? item.title : undefined;
		const content = typeof item.content === 'string' && item.content.length > 0 ? item.content : undefined;
		const publishedAt =
			typeof item.publishedDate === 'string' && item.publishedDate.length > 0
				? item.publishedDate
				: typeof item.pubdate === 'string' && item.pubdate.length > 0
					? item.pubdate
					: undefined;
		sources.push({
			url,
			...title !== undefined ? { title } : {},
			...content !== undefined ? { snippet: content } : {},
			...publishedAt !== undefined ? { publishedAt } : {},
		});
	}
	return {
		sources,
		truncated: false,
		unresponsiveEngines: readUnresponsiveEngines(body),
		answers: readAnswers(body),
		suggestions: readSuggestions(body),
	};
}

/**
 * Compose the `content` block the web tool renders ABOVE the source list.
 *
 * `formatSearchOutput` puts this first, which makes it the only place a
 * provider can tell the model something about the search itself rather than
 * about one result. Every line here is conditional, because this text is paid
 * for on every single search:
 *
 * - answers, when SearXNG resolved one outright;
 * - a coverage warning, when engines failed — otherwise a thin result set reads
 *   as a thin web;
 * - the escalation to `web_fetch`, because snippets are index summaries and a
 *   question about live state (a price, a status, a count) cannot be answered
 *   from them. The search tool's own guidance says this only when `web_fetch`
 *   is mounted in the SAME composition, which is not true when the tool is
 *   mounted per-preset and the fetch half is mounted host-plane;
 * - the suggested queries, only when nothing was found and retrying differently
 *   is the whole of the useful advice;
 * - the freshness-filter warning, because `time_range` is quietly destructive on
 *   an engine that does not implement it (bing returns ten results unfiltered
 *   and zero for the same query with `time_range=week`, without reporting
 *   itself unresponsive). Only engines that support time filtering — the news
 *   engines, chiefly — narrow rather than empty.
 *
 * @param parts - the mapped page data, the active window, and the truncation verdict.
 * @returns the content block, or undefined when there is nothing worth saying.
 */
function buildSearchContent({ sources, answers, unresponsiveEngines, suggestions, truncated, timeRange = '' }) {
	const lines = [];
	if (answers.length > 0) lines.push(answers.join('\n'));
	if (unresponsiveEngines.length > 0) {
		lines.push(
			`Search coverage was degraded — these engines returned nothing: ${unresponsiveEngines.join(', ')}. ` +
				'Missing or thin results may reflect that rather than the web itself.',
		);
	}
	if (sources.length > 0) {
		lines.push(
			'Snippets below are search-index summaries and may be stale or truncated. ' +
				'Call web_fetch on a source URL to read its current content before relying on ' +
				'anything time-sensitive (prices, availability, counts, status).',
		);
	}
	if (truncated) lines.push('More pages of results are available for this query.');
	if (sources.length === 0 && timeRange.length > 0) {
		lines.push(
			`No results inside the \`${timeRange}\` freshness window. Engines that do not implement ` +
				'time filtering return nothing rather than ignoring it, so this may be the filter and not ' +
				'the query — retry without the window, or search the `news` category, where it is supported.',
		);
	}
	if (sources.length === 0 && suggestions.length > 0) {
		lines.push(`SearXNG suggested instead: ${suggestions.join(', ')}.`);
	}
	return lines.length === 0 ? undefined : lines.join('\n\n');
}

/**
 * Build the SearXNG JSON search URL for one page of a request.
 *
 * Note what is NOT sent: SearXNG has no result-count parameter. It accepts a
 * `count` and ignores it — a request for three results still returns ten — so
 * the size of the answer is controlled by `pageno` and trimmed here, never
 * asked for upstream.
 *
 * @param baseURL - the instance base URL, without a trailing slash.
 * @param request - the seam's search request.
 * @param options - the resolved plugin options.
 * @param pageno - the 1-based result page to fetch.
 * @returns the fully-formed JSON search URL.
 */
function buildSearchUrl(baseURL, request, options, pageno = 1) {
	const url = new URL(`${baseURL.replace(/\/+$/, '')}/search`);
	url.searchParams.set('q', request.query);
	url.searchParams.set('format', 'json');
	if (Number.isInteger(pageno) && pageno > 1) url.searchParams.set('pageno', String(pageno));
	if (options.categories != null && options.categories.length > 0) {
		url.searchParams.set('categories', options.categories);
	}
	if (options.engines != null && options.engines.length > 0) {
		url.searchParams.set('engines', options.engines);
	}
	if (options.timeRange != null && options.timeRange.length > 0) {
		url.searchParams.set('time_range', options.timeRange);
	}
	if (options.language != null && options.language.length > 0) {
		url.searchParams.set('language', options.language);
	}
	return url;
}

/** Project one resolved config section into the options used for a search. */
function resolveOptions(config) {
	const timeRange = (config.timeRange ?? '').trim();
	return {
		baseURL: (config.baseURL ?? SEARXNG_DEFAULT_BASE_URL).replace(/\/+$/, ''),
		maxResults: config.maxResults ?? SEARXNG_DEFAULT_MAX_RESULTS,
		maxPages: config.maxPages ?? SEARXNG_DEFAULT_MAX_PAGES,
		categories: config.categories ?? '',
		engines: config.engines ?? '',
		// An unknown window is dropped rather than sent: SearXNG rejects the whole
		// search on a bad `time_range`, which would turn a typo into an outage.
		timeRange: SEARXNG_TIME_RANGES.includes(timeRange) ? timeRange : '',
		language: config.language ?? '',
		userAgent: config.userAgent ?? USER_AGENT,
	};
}

/** The SearXNG-backed search provider. */
class SearxngSearchProvider {
	constructor(resolveOptionsThunk) {
		this.resolveOptionsThunk = resolveOptionsThunk;
	}

	id = SEARXNG_PROVIDER_ID;

	available() {
		const options = this.resolveOptionsThunk();
		return options.baseURL.length > 0 && URL.canParse(options.baseURL);
	}

	/**
	 * Fetch and parse one result page.
	 *
	 * @param url - the page's JSON search URL.
	 * @param options - the resolved plugin options, for the attribution header.
	 * @param signal - the seam's cancellation signal, if any.
	 * @returns the mapped page.
	 */
	async fetchPage(url, options, signal) {
		let response;
		try {
			response = await fetch(url, {
				method: 'GET',
				redirect: 'follow',
				headers: {
					accept: 'application/json',
					'user-agent': options.userAgent,
				},
				...signal !== undefined ? { signal } : {},
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
		}

		if (!response.ok) {
			throw new WebError(`SearXNG returned HTTP ${response.status}`, 'WEB_PROVIDER_ERROR');
		}

		try {
			return mapSearxngResponse(await response.json());
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`SearXNG returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', {
				cause: error,
			});
		}
	}

	async search(request, signal) {
		const options = this.resolveOptionsThunk();
		if (signal?.aborted === true) throw searchAborted(signal);

		// The seam caps `sources[]` at `request.maxResults` and stamps `truncated`
		// itself if we over-return, so anything fetched past that cap is a page the
		// caller can never see. Take the tighter of the two: the deployment's cap is
		// a ceiling, this plugin's config a default sitting under it.
		const caps = [options.maxResults, request.maxResults].filter((cap) => Number.isInteger(cap) && cap > 0);
		const wanted = caps.length > 0 ? Math.min(...caps) : SEARXNG_DEFAULT_MAX_RESULTS;
		const maxPages = Math.max(1, options.maxPages ?? SEARXNG_DEFAULT_MAX_PAGES);

		const seen = new Set();
		const sources = [];
		const unresponsiveEngines = new Set();
		let answers = [];
		let suggestions = [];
		let morePages = false;

		for (let pageno = 1; pageno <= maxPages; pageno += 1) {
			if (signal?.aborted === true) throw searchAborted(signal);
			const page = await this.fetchPage(buildSearchUrl(options.baseURL, request, options, pageno), options, signal);
			for (const label of page.unresponsiveEngines) unresponsiveEngines.add(label);
			if (pageno === 1) {
				answers = page.answers;
				suggestions = page.suggestions;
			}
			let added = 0;
			for (const source of page.sources) {
				if (seen.has(source.url)) continue;
				seen.add(source.url);
				added += 1;
				if (sources.length < wanted) sources.push(source);
				else morePages = true;
			}
			// A page that contributed nothing new is the end of the result set; a
			// further page would repeat it and cost another upstream round-trip.
			if (added === 0) break;
			// `morePages` is only ever set by discarding a source above, i.e. by
			// having seen one we could not return. Filling the quota exactly is not
			// evidence that a further page exists — several engines here serve one
			// page and nothing behind it — and claiming otherwise sends the model
			// paging after results that are not there.
			if (sources.length >= wanted) break;
		}

		const dead = [...unresponsiveEngines];

		// A search that found nothing while engines were failing has not
		// established that there is nothing to find, and "No results found." is
		// exactly how the model would read it. Say what actually happened instead:
		// this is the difference between a wrong answer and a retry.
		if (sources.length === 0 && dead.length > 0) {
			throw new WebError(
				`SearXNG returned no results and ${dead.length} engine(s) failed on this query: ${dead.join(', ')}. ` +
					'Coverage was incomplete, so this is not evidence that no results exist — ' +
					'retry, narrow the query, or pin working engines in the provider config.',
				'WEB_PROVIDER_ERROR',
			);
		}

		const truncated = morePages;
		const content = buildSearchContent({
			sources,
			answers,
			unresponsiveEngines: dead,
			suggestions,
			truncated,
			timeRange: options.timeRange,
		});
		return {
			...content !== undefined ? { content } : {},
			sources,
			truncated,
		};
	}
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal, fallback) {
	return new WebError('SearXNG search aborted', 'WEB_ABORTED', {
		cause: signal?.aborted === true ? signal.reason : fallback,
	});
}

const Config = z.object({
	baseURL: z.string().default(SEARXNG_DEFAULT_BASE_URL),
	maxResults: z.number().step(1).min(1).default(SEARXNG_DEFAULT_MAX_RESULTS),
	maxPages: z.number().step(1).min(1).default(SEARXNG_DEFAULT_MAX_PAGES),
	categories: z.string().default(''),
	engines: z.string().default(''),
	timeRange: z.union(SEARXNG_TIME_RANGES.map((value) => z.const(value)).concat(z.const(''))).default(''),
	language: z.string().default(''),
	userAgent: z.string().default(USER_AGENT),
});

/** Cordis plugin name used by loader diagnostics. */
const name = 'web-search-searxng';

const inject = ['web'];

/** Register the SearXNG search provider with `ctx.web`. */
function apply(ctx, config) {
	const resolve = () => resolveOptions(config ?? {});
	// Register returns a disposer owned by this fiber; stop/update removes it.
	ctx.web.registerSearchProvider(new SearxngSearchProvider(resolve));
}

export {
	Config,
	SEARXNG_DEFAULT_BASE_URL,
	SEARXNG_DEFAULT_MAX_PAGES,
	SEARXNG_DEFAULT_MAX_RESULTS,
	SEARXNG_PROVIDER_ID,
	SEARXNG_TIME_RANGES,
	SearxngSearchProvider,
	apply,
	// Exported for the tests: all four are pure, and the response mapping is where
	// a malformed upstream payload would otherwise turn into a bad search result.
	buildSearchContent,
	buildSearchUrl,
	inject,
	mapSearxngResponse,
	name,
	resolveOptions,
};
