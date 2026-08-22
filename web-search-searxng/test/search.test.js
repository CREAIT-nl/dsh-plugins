/**
 * The pure half of the provider: turning config into request options, a request
 * into a URL, and SearXNG's JSON into the seam's result shape. The network half
 * is covered by `scripts/smoke.sh` against a real instance; what is worth
 * testing without one is the mapping, because a self-hosted SearXNG behind an
 * odd engine set is exactly where a malformed row shows up.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	SEARXNG_DEFAULT_BASE_URL,
	SEARXNG_DEFAULT_MAX_RESULTS,
	buildSearchUrl,
	mapSearxngResponse,
	resolveOptions,
} from '../lib/index.js';

describe('resolveOptions', () => {
	it('falls back to the shipped defaults', () => {
		const options = resolveOptions({});
		assert.equal(options.baseURL, SEARXNG_DEFAULT_BASE_URL);
		assert.equal(options.maxResults, SEARXNG_DEFAULT_MAX_RESULTS);
		assert.equal(options.categories, '');
		assert.equal(options.language, '');
		assert.ok(options.userAgent.length > 0);
	});

	it('strips trailing slashes so the /search path never doubles up', () => {
		assert.equal(resolveOptions({ baseURL: 'http://searx.example///' }).baseURL, 'http://searx.example');
	});
});

describe('buildSearchUrl', () => {
	const options = resolveOptions({});

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
	});

	it('sends the filters once they are configured', () => {
		const configured = resolveOptions({ categories: 'science', language: 'en' });
		const url = buildSearchUrl(configured.baseURL, { query: 'q' }, configured);
		assert.equal(url.searchParams.get('categories'), 'science');
		assert.equal(url.searchParams.get('language'), 'en');
	});
});

describe('mapSearxngResponse', () => {
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
		assert.deepEqual(mapSearxngResponse({ results: [] }), { sources: [], truncated: false });
	});

	it('survives a response that is not shaped like one at all', () => {
		for (const body of [undefined, null, {}, { results: 'nope' }]) {
			assert.deepEqual(mapSearxngResponse(body), { sources: [], truncated: false });
		}
	});
});
