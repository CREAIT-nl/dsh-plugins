/**
 * The pure half of the provider: turning config into request options, a request
 * into a URL, and SearXNG's JSON into the seam's result shape. The network half
 * is covered by `scripts/smoke.sh` against a real instance; what is worth
 * testing without one is the mapping, because a self-hosted SearXNG behind an
 * odd engine set is exactly where a malformed row shows up.
 *
 * Paging and the degraded-coverage verdict are driven against a stubbed `fetch`
 * rather than left to the smoke script: both decide what the model is told a
 * search MEANT, and getting either wrong is silent.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	SEARXNG_DEFAULT_BASE_URL,
	SEARXNG_DEFAULT_MAX_PAGES,
	SEARXNG_DEFAULT_MAX_RESULTS,
	SearxngSearchProvider,
	buildSearchContent,
	buildSearchUrl,
	mapSearxngResponse,
	resolveOptions,
} from '../lib/index.js';

describe('resolveOptions', () => {
	it('falls back to the shipped defaults', () => {
		const options = resolveOptions({});
		assert.equal(options.baseURL, SEARXNG_DEFAULT_BASE_URL);
		assert.equal(options.maxResults, SEARXNG_DEFAULT_MAX_RESULTS);
		assert.equal(options.maxPages, SEARXNG_DEFAULT_MAX_PAGES);
		assert.equal(options.categories, '');
		assert.equal(options.engines, '');
		assert.equal(options.timeRange, '');
		assert.equal(options.language, '');
		assert.ok(options.userAgent.length > 0);
	});

	it('strips trailing slashes so the /search path never doubles up', () => {
		assert.equal(resolveOptions({ baseURL: 'http://searx.example///' }).baseURL, 'http://searx.example');
	});

	it('keeps a freshness window SearXNG understands', () => {
		assert.equal(resolveOptions({ timeRange: 'week' }).timeRange, 'week');
	});

	it('drops an unknown window rather than letting it fail the whole search', () => {
		assert.equal(resolveOptions({ timeRange: 'fortnight' }).timeRange, '');
	});
});

describe('buildSearchUrl', () => {
	// A URL can only be built against an instance, and `baseURL` has no default:
	// an unconfigured provider reports itself unavailable and is never asked to
	// search, which is what keeps a bundle-mounted row from making the seam
	// ambiguous.
	const options = resolveOptions({ baseURL: 'http://searxng.test' });

	it('asks for JSON and carries the query', () => {
		const url = buildSearchUrl(options.baseURL, { query: 'sparse autoencoders' }, options);
		assert.equal(url.pathname, '/search');
		assert.equal(url.searchParams.get('format'), 'json');
		assert.equal(url.searchParams.get('q'), 'sparse autoencoders');
	});

	it('omits the optional filters rather than sending them empty', () => {
		const url = buildSearchUrl(options.baseURL, { query: 'q' }, options);
		assert.equal(url.searchParams.has('categories'), false);
		assert.equal(url.searchParams.has('language'), false);
		assert.equal(url.searchParams.has('engines'), false);
		assert.equal(url.searchParams.has('time_range'), false);
	});

	it('sends the filters once they are configured', () => {
		const configured = resolveOptions({
			baseURL: 'http://searxng.test',
			categories: 'science',
			language: 'en',
			engines: 'bing,google',
			timeRange: 'day',
		});
		const url = buildSearchUrl(configured.baseURL, { query: 'q' }, configured);
		assert.equal(url.searchParams.get('categories'), 'science');
		assert.equal(url.searchParams.get('language'), 'en');
		assert.equal(url.searchParams.get('engines'), 'bing,google');
		assert.equal(url.searchParams.get('time_range'), 'day');
	});

	it('never sends `count`, which SearXNG accepts and ignores', () => {
		const url = buildSearchUrl(options.baseURL, { query: 'q', maxResults: 3 }, options);
		assert.equal(url.searchParams.has('count'), false);
	});

	it('pages with `pageno`, and leaves it off the first page', () => {
		assert.equal(buildSearchUrl(options.baseURL, { query: 'q' }, options, 1).searchParams.has('pageno'), false);
		assert.equal(buildSearchUrl(options.baseURL, { query: 'q' }, options, 2).searchParams.get('pageno'), '2');
	});
});

describe('mapSearxngResponse', () => {
	/** The envelope fields a body carries when it says nothing beyond its results. */
	const quiet = { truncated: false, unresponsiveEngines: [], answers: [], suggestions: [] };

	it('reads a well-formed result into the seam shape', () => {
		const { sources, truncated } = mapSearxngResponse({
			results: [{ url: 'https://a.example', title: 'A', content: 'snippet', publishedDate: '2026-01-02' }],
		});
		assert.equal(truncated, false);
		assert.deepEqual(sources, [
			{ url: 'https://a.example', title: 'A', snippet: 'snippet', publishedAt: '2026-01-02' },
		]);
	});

	it('accepts `pubdate` as the alternate date field some engines return', () => {
		const { sources } = mapSearxngResponse({ results: [{ url: 'https://a.example', pubdate: '2026-01-02' }] });
		assert.equal(sources[0].publishedAt, '2026-01-02');
	});

	it('omits absent fields instead of carrying empty strings', () => {
		const { sources } = mapSearxngResponse({ results: [{ url: 'https://a.example', title: '', content: '' }] });
		assert.deepEqual(sources, [{ url: 'https://a.example' }]);
	});

	it('drops rows with no usable url, and keeps the first of a duplicate', () => {
		const { sources } = mapSearxngResponse({
			results: [
				{ url: 'https://a.example', title: 'first' },
				{ url: 'https://a.example', title: 'second' },
				{ title: 'no url' },
				null,
				'not an object',
			],
		});
		assert.deepEqual(sources, [{ url: 'https://a.example', title: 'first' }]);
	});

	it('treats no hits as an empty result, not an error', () => {
		assert.deepEqual(mapSearxngResponse({ results: [] }), { sources: [], ...quiet });
	});

	it('survives a response that is not shaped like one at all', () => {
		for (const body of [undefined, null, {}, { results: 'nope' }]) {
			assert.deepEqual(mapSearxngResponse(body), { sources: [], ...quiet });
		}
	});

	it('reads failed engines as `engine (reason)` labels', () => {
		const { unresponsiveEngines } = mapSearxngResponse({
			results: [],
			unresponsive_engines: [['brave', 'Suspended: too many requests'], ['google'], 'bing', [null, 'x'], 7],
		});
		assert.deepEqual(unresponsiveEngines, ['brave (Suspended: too many requests)', 'google', 'bing']);
	});

	it('reads answers in both the object and the legacy string shape', () => {
		const { answers } = mapSearxngResponse({
			results: [],
			answers: [{ answer: 'Paris', url: 'https://x.example' }, 'Paris', 'Lyon', { answer: '  ' }],
		});
		assert.deepEqual(answers, ['Paris', 'Lyon']);
	});

	it('reads corrections ahead of suggestions', () => {
		const { suggestions } = mapSearxngResponse({
			results: [],
			corrections: ['nvidia 3090'],
			suggestions: ['nvidia 3090', 'rtx 3090 ti'],
		});
		assert.deepEqual(suggestions, ['nvidia 3090', 'rtx 3090 ti']);
	});
});

describe('buildSearchContent', () => {
	const base = { sources: [], answers: [], unresponsiveEngines: [], suggestions: [], truncated: false };

	it('says nothing when there is nothing to say', () => {
		assert.equal(buildSearchContent(base), undefined);
	});

	it('warns that thin results may be missing coverage, not missing web', () => {
		const content = buildSearchContent({ ...base, sources: [{ url: 'https://a.example' }], unresponsiveEngines: ['brave (CAPTCHA)'] });
		assert.match(content, /coverage was degraded/i);
		assert.match(content, /brave \(CAPTCHA\)/);
	});

	it('points at web_fetch whenever there are sources to follow up', () => {
		const content = buildSearchContent({ ...base, sources: [{ url: 'https://a.example' }] });
		assert.match(content, /web_fetch/);
	});

	it('offers the suggested queries only when the search found nothing', () => {
		assert.match(buildSearchContent({ ...base, suggestions: ['rtx 3090'] }), /rtx 3090/);
		assert.doesNotMatch(
			buildSearchContent({ ...base, sources: [{ url: 'https://a.example' }], suggestions: ['rtx 3090'] }),
			/suggested instead/,
		);
	});

	it('blames the freshness window when it emptied the result set', () => {
		const content = buildSearchContent({ ...base, timeRange: 'week' });
		assert.match(content, /freshness window/);
		assert.match(content, /news/);
	});

	it('stays quiet about the window when the window still found things', () => {
		const content = buildSearchContent({ ...base, sources: [{ url: 'https://a.example' }], timeRange: 'week' });
		assert.doesNotMatch(content, /freshness window/);
	});

	it('leads with an answer SearXNG resolved outright', () => {
		assert.match(buildSearchContent({ ...base, answers: ['Paris'] }), /^Paris/);
	});
});

describe('SearxngSearchProvider.search', () => {
	/**
	 * Drive the provider against canned pages. Each entry is one page body, in
	 * order; the stub records the URLs asked for so paging can be asserted.
	 */
	// `baseURL` has no default — that is what keeps an unconfigured row from
	// making `ctx.web` ambiguous — so a provider that searches at all is one that
	// was pointed at an instance. Tests that care about the URL override it.
	const INSTANCE = 'http://searxng.test';

	function providerOver(pages, config = {}) {
		const asked = [];
		const provider = new SearxngSearchProvider(() => resolveOptions({ baseURL: INSTANCE, ...config }));
		provider.fetchPage = async (url) => {
			asked.push(url);
			return mapSearxngResponse(pages[asked.length - 1] ?? { results: [] });
		};
		return { provider, asked };
	}

	/** A page of `n` distinct results, numbered from `from`. */
	function page(from, n) {
		return { results: Array.from({ length: n }, (_, i) => ({ url: `https://e${from + i}.example` })) };
	}

	it('pages until maxResults is satisfied, because SearXNG has no count param', async () => {
		const { provider, asked } = providerOver([page(0, 10), page(10, 10)], { maxResults: 15 });
		const result = await provider.search({ query: 'q' });
		assert.equal(result.sources.length, 15);
		assert.equal(asked.length, 2);
		assert.equal(asked[1].searchParams.get('pageno'), '2');
		assert.equal(result.truncated, true);
	});

	it('stops at the configured page ceiling', async () => {
		const { provider, asked } = providerOver([page(0, 10), page(10, 10), page(20, 10), page(30, 10)], {
			maxResults: 100,
			maxPages: 3,
		});
		await provider.search({ query: 'q' });
		assert.equal(asked.length, 3);
	});

	it('stops early when a page adds nothing new rather than paging into repeats', async () => {
		const { provider, asked } = providerOver([page(0, 3), page(0, 3), page(9, 3)], { maxResults: 50 });
		const result = await provider.search({ query: 'q' });
		assert.equal(asked.length, 2);
		assert.equal(result.sources.length, 3);
		assert.equal(result.truncated, false);
	});

	it('does not claim more pages merely because the quota filled exactly', async () => {
		const { provider } = providerOver([page(0, 10), { results: [] }], { maxResults: 10 });
		const result = await provider.search({ query: 'q' });
		assert.equal(result.sources.length, 10);
		assert.equal(result.truncated, false);
		assert.doesNotMatch(result.content, /More pages/);
	});

	it('never fetches past the cap the seam asked for', async () => {
		const { provider, asked } = providerOver([page(0, 10), page(10, 10)], { maxResults: 20 });
		const result = await provider.search({ query: 'q', maxResults: 8 });
		// The seam would truncate a longer list anyway, so a second page here would
		// have cost an upstream round-trip for sources the caller never sees.
		assert.equal(asked.length, 1);
		assert.equal(result.sources.length, 8);
		assert.equal(result.truncated, true);
	});

	it('reports an exhausted result set as complete, not truncated', async () => {
		const { provider } = providerOver([page(0, 4)], { maxResults: 10 });
		const result = await provider.search({ query: 'q' });
		assert.equal(result.sources.length, 4);
		assert.equal(result.truncated, false);
	});

	it('fails loudly when nothing was found AND engines were down', async () => {
		const { provider } = providerOver([
			{ results: [], unresponsive_engines: [['brave', 'CAPTCHA'], ['duckduckgo', 'CAPTCHA']] },
		]);
		await assert.rejects(provider.search({ query: 'q' }), (error) => {
			assert.equal(error.code, 'WEB_PROVIDER_ERROR');
			assert.match(error.message, /not evidence that no results exist/);
			assert.match(error.message, /brave \(CAPTCHA\)/);
			return true;
		});
	});

	it('still reports a genuine no-hit as an empty result', async () => {
		const { provider } = providerOver([{ results: [] }]);
		const result = await provider.search({ query: 'q' });
		assert.deepEqual(result.sources, []);
		assert.equal(result.truncated, false);
	});

	it('carries a degraded-coverage warning through on a partial result', async () => {
		const { provider } = providerOver([{ ...page(0, 2), unresponsive_engines: [['brave', 'CAPTCHA']] }]);
		const result = await provider.search({ query: 'q' });
		assert.equal(result.sources.length, 2);
		assert.match(result.content, /brave \(CAPTCHA\)/);
	});

	it('honours an already-aborted signal before touching the network', async () => {
		const { provider, asked } = providerOver([page(0, 10)]);
		await assert.rejects(provider.search({ query: 'q' }, AbortSignal.abort()), (error) => {
			assert.equal(error.code, 'WEB_ABORTED');
			return true;
		});
		assert.equal(asked.length, 0);
	});
});
