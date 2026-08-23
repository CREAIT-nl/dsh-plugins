/**
 * What the settings page reads and what it is allowed to write: the live
 * measurement behind each group's row, the payload check on the way in, and the
 * loopback guard standing between a settings write and the network.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compileGroups, deferredGroups, readConfig } from '../lib/catalog.js';
import {
	CONFIG_ROUTE,
	GROUPS_ROUTE,
	isLoopbackRequest,
	measureGroups,
	sameIds,
	tokensFor,
	validateDefer,
} from '../lib/settings-routes.js';

const BROWSER = {
	id: 'browser',
	match: ['mcp__playwright__*'],
	summary: 'Drive a real Chrome: navigate, click, fill forms, screenshot.',
};

const MEMORY = {
	id: 'memory',
	match: ['mcp__mem0__*'],
	summary: 'Search and write long-term memories.',
};

/** A registry stub carrying schemas of a known size. */
function ctxWith(schemas) {
	const tools = { schemas: () => schemas };
	return { get: (name) => (name === 'tools' ? tools : undefined) };
}

/** A schema padded to roughly `chars` characters of JSON. */
function schema(name, chars = 200) {
	const shell = JSON.stringify({ name, description: '' }).length;
	return { name, description: 'x'.repeat(Math.max(0, chars - shell)) };
}

describe('readConfig', () => {
	it('reads a well-formed config through unchanged', () => {
		const value = readConfig({ groups: [BROWSER], keep: ['bash'], defer: ['browser', 'mem0'] });
		assert.deepEqual(value, { groups: [BROWSER], keep: ['bash'], defer: ['browser', 'mem0'] });
	});

	it('survives a hand-edited settings file rather than crashing at assembly', () => {
		// This value comes back from the settings layer, not from the loader, so
		// nothing has validated it by the time a prompt section reads it.
		for (const input of [undefined, null, {}, { groups: 'nope', keep: 7, defer: 3 }]) {
			assert.deepEqual(readConfig(input), { groups: [], keep: [], defer: [] });
		}
	});

	it('coerces list entries to strings, since YAML will hand back numbers', () => {
		assert.deepEqual(readConfig({ keep: [12], defer: [56] }), { groups: [], keep: ['12'], defer: ['56'] });
	});

	it('drops a glob written where a group id belongs', () => {
		// A discovered group's patterns are derived from its id, so `*` here
		// compiles to a matcher claiming every tool the registry holds — one
		// hand-edited entry that defers the lot. `keep` and `match` are where
		// a glob means something.
		assert.deepEqual(readConfig({ defer: ['*', 'mcp__x__*', 'browser'] }).defer, ['browser']);
		assert.deepEqual(readConfig({ keep: ['mcp__playwright__*'] }).keep, ['mcp__playwright__*']);
	});
});

describe('deferredGroups', () => {
	const groups = compileGroups([BROWSER, MEMORY]);

	it('defers nothing when nothing is switched on', () => {
		assert.deepEqual(deferredGroups(groups, []), []);
	});

	it('takes the named group and leaves the rest advertised', () => {
		assert.deepEqual(deferredGroups(groups, ['browser']).map((group) => group.id), ['browser']);
	});

	it('returns them in config order, which is the glob tiebreak', () => {
		assert.deepEqual(deferredGroups(groups, ['memory', 'browser']).map((group) => group.id), ['browser', 'memory']);
	});

	it('ignores an id no group annotates, since it is a discovered group', () => {
		assert.deepEqual(deferredGroups(groups, ['mcp-thing']).map((group) => group.id), []);
	});
});

describe('tokensFor', () => {
	it('scales characters by the calibrated ratio', () => {
		assert.equal(tokensFor(4160), 1000);
		assert.equal(tokensFor(0), 0);
	});
});

describe('measureGroups', () => {
	const config = { groups: [BROWSER, MEMORY], keep: [], defer: [] };
	const schemas = [
		schema('bash', 400),
		schema('mcp__playwright__browser_click', 300),
		schema('mcp__playwright__browser_type', 300),
		schema('mcp__mem0__search_memory', 200),
	];
	const row = (measured, id) => measured.groups.find((entry) => entry.id === id);

	it('measures each annotated group from the live registry, not from the config', () => {
		// The whole point of the page is deciding whether a group is worth
		// deferring, and that turns on what it costs now: an MCP server that
		// grew three tools since the config was written costs three tools more.
		const measured = measureGroups(ctxWith(schemas), config);
		assert.deepEqual([row(measured, 'browser').tools, row(measured, 'browser').chars], [2, 600]);
		assert.deepEqual([row(measured, 'memory').tools, row(measured, 'memory').chars], [1, 200]);
	});

	it('gives everything no annotated group claims a row of its own', () => {
		// A page that listed only the hand-written groups while claiming to show
		// what the harness carries would be the more misleading of the two: an
		// MCP server nobody wrote a group for is exactly the cost worth seeing.
		const measured = measureGroups(ctxWith(schemas), config);
		assert.deepEqual([row(measured, 'bash').tools, row(measured, 'bash').chars], [1, 400]);
	});

	it('sorts the rows by what deferring them would save', () => {
		// One list, costliest first: config order would answer "what did
		// somebody write down", which is not the question the page is asking.
		const measured = measureGroups(ctxWith(schemas), config);
		assert.deepEqual(measured.groups.map((entry) => entry.id), ['browser', 'bash', 'memory']);
	});

	it('advertises every group until its id is named in defer', () => {
		// One switch list, and empty at rest: the plugin defers nothing at all
		// until somebody says so, whether or not a group was written down.
		const measured = measureGroups(ctxWith(schemas), config);
		assert.deepEqual(measured.groups.map((entry) => entry.deferred), [false, false, false]);
		assert.equal(measured.deferred.chars, 0);
	});

	it('holds back an annotated group and a discovered one the same way', () => {
		const measured = measureGroups(ctxWith(schemas), { ...config, defer: ['browser', 'bash'] });
		assert.equal(row(measured, 'browser').deferred, true);
		assert.equal(row(measured, 'bash').deferred, true);
		assert.equal(row(measured, 'memory').deferred, false);
		assert.equal(measured.deferred.chars, 1000);
	});

	it('names the tools behind every row, so none of them is only a count', () => {
		const measured = measureGroups(ctxWith(schemas), config);
		assert.deepEqual(row(measured, 'browser').names, [
			'mcp__playwright__browser_click',
			'mcp__playwright__browser_type',
		]);
		assert.deepEqual(row(measured, 'bash').names, ['bash']);
	});

	it('sends no summary where it would only repeat the tool names below it', () => {
		// A discovered group of several tools summarizes as those tools' short
		// names, and the row lists them anyway.
		const measured = measureGroups(ctxWith([schema('mcp__gmail__send', 200), schema('mcp__gmail__read', 200)]), { groups: [], keep: [], defer: [] });
		assert.equal(row(measured, 'gmail').summary, '');
	});

	it('keeps the hand-written summary of an annotated group', () => {
		assert.equal(measureGroups(ctxWith(schemas), config).groups.find((entry) => entry.id === 'browser').summary, BROWSER.summary);
	});

	it('counts a kept tool against the group but not against what deferring saves', () => {
		// `keep` wins over `match`, so that tool is advertised either way and
		// listing its characters as a saving would be a lie about the trade.
		const measured = measureGroups(ctxWith(schemas), { ...config, keep: ['mcp__playwright__browser_type'] });
		const browser = row(measured, 'browser');
		assert.deepEqual([browser.tools, browser.kept, browser.chars], [1, 1, 300]);
	});

	it('keeps a kept tool visible in its discovered group rather than dropping the row', () => {
		// Bucketing it elsewhere would leave a page that promises every tool
		// quietly missing one.
		const measured = measureGroups(ctxWith(schemas), { ...config, keep: ['bash'] });
		const bash = row(measured, 'bash');
		assert.deepEqual([bash.tools, bash.kept, bash.chars, bash.names], [0, 1, 0, ['bash']]);
	});

	it('reports the totals the per-group numbers sit against', () => {
		const measured = measureGroups(ctxWith(schemas), { ...config, defer: ['browser', 'bash', 'memory'] });
		assert.deepEqual(measured.total, { tools: 4, chars: 1200, tokens: tokensFor(1200) });
		assert.deepEqual(measured.deferred, { tools: 4, chars: 1200, tokens: tokensFor(1200) });
	});

	it('reports an annotated group with nothing registered as costing nothing', () => {
		const measured = measureGroups(ctxWith([schema('bash', 400)]), config);
		assert.deepEqual([row(measured, 'browser').tools, row(measured, 'memory').tools], [0, 0]);
		assert.equal(measured.deferred.chars, 0);
	});

	it('keeps the annotated row when a discovered group derives the same id', () => {
		// An annotation matching part of the bucket its id names leaves the
		// rest discovered under that same id. `sync()` gives the annotation
		// the id outright, so the row has to be the annotated one — otherwise
		// the page shows a derived summary and a cost for a group the runtime
		// is not the one deferring.
		const partial = { id: 'playwright', match: ['mcp__playwright__browser_click'], summary: 'Click things.' };
		const measured = measureGroups(ctxWith(schemas), { groups: [partial], keep: [], defer: ['playwright'] });
		const playwright = row(measured, 'playwright');
		assert.equal(measured.groups.filter((entry) => entry.id === 'playwright').length, 1);
		assert.equal(playwright.summary, 'Click things.');
		assert.deepEqual([playwright.tools, playwright.chars], [1, 300]);
	});

	it('lists the tools that row holds but its switch cannot reach, apart from the saving', () => {
		// Dropping them would leave a page that promises every tool quietly
		// missing one; counting them would promise a saving the switch does
		// not make.
		const partial = { id: 'playwright', match: ['mcp__playwright__browser_click'], summary: 'Click things.' };
		const measured = measureGroups(ctxWith(schemas), { groups: [partial], keep: [], defer: ['playwright'] });
		const playwright = row(measured, 'playwright');
		assert.equal(playwright.unclaimed, 1);
		assert.deepEqual(playwright.names, ['mcp__playwright__browser_click', 'mcp__playwright__browser_type']);
		assert.equal(measured.deferred.chars, 300);
	});

	it('reports no strays where the annotation covers its whole bucket', () => {
		assert.equal(row(measureGroups(ctxWith(schemas), config), 'browser').unclaimed, 0);
		assert.equal(row(measureGroups(ctxWith(schemas), config), 'bash').unclaimed, 0);
	});

	it('reports zeroes rather than throwing when no tools service is mounted', () => {
		const measured = measureGroups({ get: () => undefined }, config);
		assert.equal(measured.total.tools, 0);
		assert.equal(measured.groups.length, 2);
	});
});

describe('validateDefer', () => {
	it('accepts the list the page posts', () => {
		assert.deepEqual(validateDefer({ defer: ['browser', 'mem0'] }), { ok: true, defer: ['browser', 'mem0'] });
	});

	it('accepts an empty list, which is every switch back at its default', () => {
		assert.deepEqual(validateDefer({ defer: [] }), { ok: true, defer: [] });
	});

	it('refuses a body with no list rather than writing an empty one', () => {
		// A missing field is a malformed request, not a request to reset: reading
		// it as [] would advertise every group at once.
		for (const body of [undefined, null, {}, { defer: 'browser' }, { off: ['browser'] }]) {
			assert.deepEqual(validateDefer(body), { ok: false });
		}
	});

	it('keeps an id the registry does not currently carry', () => {
		// A group exists only while the thing behind it does. Filtering against
		// the live registry would clear the switch of every MCP server that
		// happened to be down, and each would come back advertised.
		assert.deepEqual(validateDefer({ defer: ['mem0', 'playwright'] }).defer, ['mem0', 'playwright']);
	});

	it('collapses duplicates and coerces to strings', () => {
		assert.deepEqual(validateDefer({ defer: ['browser', 'browser', 7, 7] }), { ok: true, defer: ['browser', '7'] });
	});

	it('bounds the list, which nothing else checks', () => {
		const checked = validateDefer({ defer: [...Array(600).keys()].map(String).concat('x'.repeat(200)) });
		assert.equal(checked.defer.length, 512);
		assert.equal(checked.defer.some((id) => id.length > 128), false);
	});

	it('drops an id carrying a glob, which would claim the whole registry', () => {
		// The page posts ids it rendered, so this is the crafted-request case:
		// `*` derives a pattern matching every tool, deferring the lot from one
		// entry that reads on screen like any other.
		assert.deepEqual(validateDefer({ defer: ['*', 'browser', 'mcp__x__*'] }), { ok: true, defer: ['browser'] });
	});
});

describe('sameIds', () => {
	it('reads a reorder as no change, so it does not burn a revision', () => {
		assert.equal(sameIds(['browser', 'mem0'], ['mem0', 'browser']), true);
	});

	it('sees an added, a dropped and a swapped id', () => {
		assert.equal(sameIds(['browser'], ['browser', 'mem0']), false);
		assert.equal(sameIds(['browser', 'mem0'], ['browser']), false);
		assert.equal(sameIds(['browser'], ['mem0']), false);
	});

	it('reads two empty lists as the same, which is the inert plugin', () => {
		assert.equal(sameIds([], []), true);
	});
});

describe('the plugin routes', () => {
	it('all sit under one namespaced prefix', () => {
		for (const route of [CONFIG_ROUTE, GROUPS_ROUTE]) {
			assert.match(route, /^\/api\/dsh-tool-disclosure\//);
		}
	});
});

describe('isLoopbackRequest', () => {
	const request = (overrides = {}) => ({
		socket: { remoteAddress: '127.0.0.1' },
		headers: { host: '127.0.0.1:3080' },
		...overrides,
	});

	it('admits a same-origin request from loopback', () => {
		assert.equal(isLoopbackRequest(request()), true);
	});

	it('admits the IPv6 and IPv4-mapped loopback forms', () => {
		for (const remoteAddress of ['::1', '::ffff:127.0.0.1']) {
			assert.equal(isLoopbackRequest(request({ socket: { remoteAddress } })), true);
		}
	});

	it('refuses a request from off-box, whatever the Host header claims', () => {
		assert.equal(isLoopbackRequest(request({ socket: { remoteAddress: '10.0.0.7' } })), false);
	});

	it('refuses a loopback connection carrying a non-loopback Host', () => {
		assert.equal(isLoopbackRequest(request({ headers: { host: 'evil.example' } })), false);
	});

	it('refuses a request with no Host header to compare against', () => {
		assert.equal(isLoopbackRequest(request({ headers: {} })), false);
	});

	it('refuses a cross-site fetch, which is the shape a DNS-rebind write takes', () => {
		const headers = { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' };
		assert.equal(isLoopbackRequest(request({ headers })), false);
	});

	it('refuses a foreign Origin and admits a matching one', () => {
		const with_ = (origin) => request({ headers: { host: '127.0.0.1:3080', origin } });
		assert.equal(isLoopbackRequest(with_('http://evil.example')), false);
		assert.equal(isLoopbackRequest(with_('http://127.0.0.1:3080')), true);
		assert.equal(isLoopbackRequest(with_('not a url')), false);
	});
});
