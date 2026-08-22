/**
 * SearXNG-backed web search provider for the `ctx.web` capability seam.
 *
 * Replaces the model-facing `web_search` backend (default: the DeepSeek native
 * search route) with a query against a SearXNG metasearch instance. The provider
 * is a plain static Node plugin, so unlike a dynamic Cordis package it may use
 * the global `fetch` to reach SearXNG. Results are normalized into the seam's
 * `WebSearchResult` shape (`sources[]` with url/title/snippet/publishedAt).
 *
 * @module @creait/dsh-web-search-searxng
 */

import z from '@deepseek-ai/schemastery';
import { WebError } from '@deepseek-ai/dsh-web';

/** Stable id this provider registers under in the search capability kind. */
const SEARXNG_PROVIDER_ID = 'searxng';

/**
 * Default SearXNG instance base URL (no trailing slash): the port the
 * `searxng/searxng` image listens on. Set `baseURL` in the plugin config to
 * point at your own instance — this default only spares a purely local setup
 * from needing one.
 */
const SEARXNG_DEFAULT_BASE_URL = 'http://localhost:8080';

/** Default number of results requested from SearXNG. */
const SEARXNG_DEFAULT_MAX_RESULTS = 10;

/** Attribution header sent on every request. */
const USER_AGENT = 'deepseek-harness/0.0.1 (searxng search)';

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Map a SearXNG `/search?format=json` response to a normalized search result.
 * SearXNG returns `{ results: [{ title, url, content, publishedDate, ... }] }`
 * plus engine diagnostics we do not surface. Empty `results` is a legitimate
 * no-hit outcome, not an error, so it maps to an empty `sources` list.
 *
 * @param body - the parsed SearXNG JSON response.
 * @returns the normalized result with deduped, sized sources.
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
	// The web seam re-enforces maxResults regardless, but trimming here keeps the
	// payload small (SearXNG commonly returns 10-20 results).
	// The web seam owns truncation; the provider reports false.
	return { sources, truncated: false };
}

/** Build the SearXNG JSON search URL from a request and resolved options. */
function buildSearchUrl(baseURL, request, options) {
	const url = new URL(`${baseURL.replace(/\/+$/, '')}/search`);
	url.searchParams.set('q', request.query);
	url.searchParams.set('format', 'json');
	const count = options.maxResults ?? (request.maxResults ?? SEARXNG_DEFAULT_MAX_RESULTS);
	if (Number.isInteger(count) && count > 0) url.searchParams.set('count', String(count));
	if (options.categories != null && options.categories.length > 0) {
		url.searchParams.set('categories', options.categories);
	}
	if (options.language != null && options.language.length > 0) {
		url.searchParams.set('language', options.language);
	}
	return url;
}

/** Project one resolved config section into the options used for a search. */
function resolveOptions(config) {
	return {
		baseURL: (config.baseURL ?? SEARXNG_DEFAULT_BASE_URL).replace(/\/+$/, ''),
		maxResults: config.maxResults ?? SEARXNG_DEFAULT_MAX_RESULTS,
		categories: config.categories ?? '',
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

	async search(request, signal) {
		const options = this.resolveOptionsThunk();
		if (signal?.aborted === true) throw searchAborted(signal);

		const url = buildSearchUrl(options.baseURL, request, options);

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
	categories: z.string().default(''),
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
	SEARXNG_DEFAULT_MAX_RESULTS,
	SEARXNG_PROVIDER_ID,
	SearxngSearchProvider,
	apply,
	// Exported for the tests: both are pure, and the response mapping is where a
	// malformed upstream payload would otherwise turn into a bad search result.
	buildSearchUrl,
	inject,
	mapSearxngResponse,
	name,
	resolveOptions,
};
