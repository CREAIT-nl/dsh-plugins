/**
 * The settings page's behaviour, driven through real hook semantics.
 *
 * These cover what a live page cannot show: that a failed write still leaves
 * the switches telling the truth, that the numbers on screen came back from the
 * host rather than from the optimistic flip, and that the posted `defer` list
 * is rebuilt from what is rendered instead of patched into whatever the server
 * last sent. The browser proves the page renders and that a write lands.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONFIG_ROUTE, GROUPS_ROUTE, loadClient, propsFor, renderRow, rowsOf, settle, statsOf, switchOf, walk } from './client-harness.js';

const measured = (overrides = {}) => ({
	groups: [
		{ id: 'browser', summary: 'Drive a real Chrome.', deferred: true, tools: 24, kept: 0, chars: 18502, tokens: 4448, names: ['mcp__playwright__browser_click', 'mcp__playwright__browser_type'] },
		{ id: 'memory', summary: 'Long-term memories.', deferred: false, tools: 6, kept: 0, chars: 4160, tokens: 1000, names: ['mcp__mem0__search_memory'] },
		{ id: 'gmail', summary: '', deferred: false, tools: 2, kept: 0, chars: 2080, tokens: 500, names: ['mcp__gmail__authenticate', 'mcp__gmail__send_email'] },
	],
	total: { tools: 58, chars: 46870, tokens: 11267 },
	deferred: { tools: 24, chars: 18502, tokens: 4448 },
	...overrides,
});

const ready = { status: 'ready', value: { defer: ['browser'] }, writable: true, revision: 3 };

/** Mount the page with both GETs answered and every effect settled. */
async function open(options = {}) {
	const client = loadClient({ groups: { body: measured() }, config: { body: ready }, ...options });
	const instance = client.mount(client.Component, propsFor());
	await settle();
	return { client, instance };
}

describe('registration', () => {
	it('registers under the full package name, which is what the loader looks up', () => {
		// A short id loads without error and then fails the loader's
		// `factories.has(row.id)` check — "loaded without registering".
		assert.equal(loadClient().id, '@creait/dsh-tool-disclosure');
	});

	it('declares exactly the services it uses', () => {
		// Copied first: the bundle is evaluated in its own realm, so its array
		// literal has that realm's prototype and would fail a strict deep-equal
		// for a reason that has nothing to do with the contents.
		assert.deepEqual([...loadClient().inject], ['slots', 'locale']);
	});

	it('claims the settings.section slot, which is the only one with a nav entry', () => {
		const { descriptor } = loadClient();
		assert.equal(descriptor.name, 'settings.section');
		assert.equal(descriptor.id, 'dsh-tool-disclosure');
		assert.equal(descriptor.locale, 'dsh-tool-disclosure');
	});

	it('registers both locales with matching keys, so no label is ever a bare key', () => {
		const { locales } = loadClient();
		assert.deepEqual(Object.keys(locales[0].bundles).sort(), ['en', 'zh']);
		const [zh, en] = [locales[0].bundles.zh, locales[0].bundles.en];
		assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
	});

	it('mounts with no document at all, which is what a headless load has', () => {
		// The CSS injection and the nav-icon repaint both touch `document`; the
		// harness has none, so an unguarded reach throws right here.
		assert.deepEqual(loadClient().warnings, []);
	});
});

describe('reading', () => {
	it('asks for the measurement and the writability, and nothing else', async () => {
		const { client } = await open();
		assert.deepEqual(client.requests.map((request) => `${request.method} ${request.url}`).sort(), [
			`GET ${CONFIG_ROUTE}`,
			`GET ${GROUPS_ROUTE}`,
		]);
	});

	it('renders one row per group, configured first and discovered after', async () => {
		const { instance } = await open();
		assert.deepEqual(rowsOf(instance).map((row) => row.props.group.id), ['browser', 'memory', 'gmail']);
	});

	it('lists a group nobody configured beside the ones somebody did', async () => {
		// An MCP server that was mounted and forgotten is invisible until it has
		// a row; this is where it shows up as the thing it costs, in the same
		// list and with the same switch as a group the patch wrote down.
		const { instance } = await open();
		const gmail = rowsOf(instance).find((row) => row.props.group.id === 'gmail');
		assert.equal(switchOf(gmail).props['aria-checked'], 'false');
		assert.match(JSON.stringify(renderRow(gmail)), /mcp__gmail__authenticate, mcp__gmail__send_email/);
	});

	it('names the tools in a row rather than leaving them a count', async () => {
		const { instance } = await open();
		const row = JSON.stringify(renderRow(rowsOf(instance)[0]));
		assert.match(row, /mcp__playwright__browser_click, mcp__playwright__browser_type/);
	});

	it('does not print a discovered summary that is just its tool names again', async () => {
		// The host derives that summary FROM the names, so a row showing both
		// says the same thing twice.
		const { instance } = await open();
		const gmail = rowsOf(instance).find((row) => row.props.group.id === 'gmail');
		assert.doesNotMatch(JSON.stringify(renderRow(gmail)), /td-summary/);
	});

	it('shows each switch in the state the host reports', async () => {
		const { instance } = await open();
		const [browser, memory] = rowsOf(instance).map(switchOf);
		assert.equal(browser.props['aria-checked'], 'true');
		assert.equal(memory.props['aria-checked'], 'false');
	});

	it('headlines what is held back, against the registry it was measured from', async () => {
		// It does not derive a "still advertised" figure: the host measures the
		// shared registry, and a session mounts mode tools on top of it, so
		// that number would be a guess wearing a decimal point.
		const { instance } = await open();
		// `t` is the identity here, so the "approx" prefix renders as its key.
		assert.deepEqual(statsOf(instance), { savedLabel: 'approx4.4k', deferredToolsLabel: '24' });
	});

	it('says plainly when nothing is deferred rather than showing a zero', async () => {
		const groups = measured({ deferred: { tools: 0, chars: 0, tokens: 0 } });
		groups.groups = groups.groups.map((group) => ({ ...group, deferred: false }));
		const { instance } = await open({ groups: { body: groups } });
		assert.equal(rowsOf(instance).every((row) => switchOf(row).props['aria-checked'] === 'false'), true);
		assert.match(JSON.stringify(instance.output), /savingNone/);
	});

	it('explains where the list comes from, rather than only listing it', async () => {
		// The page owns switches, not group definitions, so it has to say where
		// a group gets its name, its globs and its summary.
		const { instance } = await open();
		assert.match(JSON.stringify(instance.output), /groupsHint/);
	});

	it('says the registry is empty rather than rendering a bare heading', async () => {
		const { instance } = await open({ groups: { body: measured({ groups: [], deferred: { tools: 0, chars: 0, tokens: 0 } }) } });
		assert.deepEqual(rowsOf(instance), []);
		assert.match(JSON.stringify(instance.output), /"empty"/);
	});

	it('names a group whose tools are not registered rather than hiding the row', async () => {
		// An MCP server that failed to start leaves its group claiming nothing.
		// Dropping the row would read as "the group is gone".
		const groups = measured();
		groups.groups[0] = { ...groups.groups[0], tools: 0, tokens: 0, chars: 0 };
		const { instance } = await open({ groups: { body: groups } });
		const row = renderRow(rowsOf(instance)[0]);
		assert.match(JSON.stringify(row), /noneMatched/);
	});

	it('holds the switches read-only where the deployment stores settings read-only', async () => {
		const { instance } = await open({ config: { body: { ...ready, writable: false } } });
		assert.equal(switchOf(rowsOf(instance)[0]).props.disabled, true);
	});

	it('says the read failed rather than sitting on the loading line forever', async () => {
		// A 403 from off-box, an absent settings service and a route that never
		// mounted all arrive here as the same rejected fetch. Rendering that as
		// "Reading…" claims a request is still in flight when none is.
		const { instance } = await open({ groups: 'network', config: 'network' });
		const text = JSON.stringify(instance.output);
		assert.match(text, /unreachable/);
		assert.doesNotMatch(text, /loading/);
	});

	it('keeps saying so beside numbers that a later read failed to refresh', async () => {
		// The figures on screen are a measurement of a moment. One that could
		// not be re-taken is stale, and a page that hid that would be quoting
		// it as current.
		let reads = 0;
		const { instance } = await open({ groups: () => (++reads === 1 ? { body: measured() } : 'network') });
		rowsOf(instance)[0].props.onToggle('browser');
		await settle();
		const text = JSON.stringify(instance.output);
		assert.match(text, /unreachable/);
		assert.equal(rowsOf(instance).length, 3);
	});

	it('names the tools a group holds but its switch cannot reach', async () => {
		// An annotation whose globs cover part of the bucket its id names: the
		// rest is listed on the row, and counted apart from what deferring it
		// would save.
		const groups = measured();
		groups.groups[0] = { ...groups.groups[0], tools: 1, unclaimed: 3 };
		const { instance } = await open({ groups: { body: groups } });
		assert.match(JSON.stringify(renderRow(rowsOf(instance)[0])), /unclaimedNote/);
	});
});

describe('writing', () => {
	it('posts the whole list rebuilt from what is on screen', async () => {
		// Replace-all. Rebuilding it from the rendered rows is what makes a
		// group switched off fall out of the user layer instead of lingering
		// there as a stale id.
		const { client, instance } = await open();
		rowsOf(instance)[2].props.onToggle('gmail');
		await settle();
		const post = client.requests.find((request) => request.method === 'POST');
		assert.deepEqual(post.body, { defer: ['browser', 'gmail'] });
	});

	it('switches a group back on by dropping it from the list', async () => {
		const { client, instance } = await open();
		rowsOf(instance)[0].props.onToggle('browser');
		await settle();
		assert.deepEqual(client.requests.find((request) => request.method === 'POST').body, { defer: [] });
	});

	it('treats an annotated group and a discovered one as the same kind of row', async () => {
		// One list and one default, so the id is all the switch has to say —
		// whether or not the patch wrote that group down.
		const { client, instance } = await open();
		rowsOf(instance)[1].props.onToggle('memory');
		await settle();
		assert.deepEqual(client.requests.find((request) => request.method === 'POST').body, { defer: ['browser', 'memory'] });
	});

	it('moves the switch immediately rather than waiting for the round trip', async () => {
		// A switch that waits on the network reads as broken.
		const { instance } = await open({ post: 'network' });
		rowsOf(instance)[0].props.onToggle('browser');
		assert.equal(switchOf(rowsOf(instance)[0]).props['aria-checked'], 'false');
	});

	it('takes the numbers from the re-measure, not from the optimistic flip', async () => {
		// What a group costs is a fact about the live registry; only the host
		// knows it, and a write can change which groups are counted.
		let reads = 0;
		const { instance } = await open({
			groups: () => {
				reads += 1;
				return { body: reads === 1 ? measured() : measured({ deferred: { tools: 0, chars: 0, tokens: 0 } }) };
			},
		});
		rowsOf(instance)[0].props.onToggle('browser');
		await settle();
		assert.equal(statsOf(instance).savedLabel, 'approx0');
		assert.equal(reads, 2);
	});

	it('re-reads after a rejected write, so the switch stops lying about the state', async () => {
		const { client, instance } = await open({ post: { status: 409 } });
		rowsOf(instance)[0].props.onToggle('browser');
		await settle();
		assert.equal(client.requests.filter((request) => request.url === GROUPS_ROUTE).length, 2);
		assert.equal(client.warnings.length, 1);
	});

	it('drops a response that arrives after the panel closed', async () => {
		// Setting state on an unmounted component is the classic warning, and
		// here it would also mean rendering a page nobody is looking at.
		const { client, instance } = await open();
		rowsOf(instance)[0].props.onToggle('browser');
		instance.unmount();
		await settle();
		assert.equal(client.requests.filter((request) => request.url === GROUPS_ROUTE).length, 1);
	});
});

describe('the primitives path', () => {
	// Every other test in this file runs with the seed module absent, which is
	// the fallback arm. In a browser it always resolves, so the arm that
	// actually ships needs its own pass — otherwise a break in it is invisible
	// here and visible only to a user.
	/** The element each `StatRow` puts its figure in, once the row is rendered. */
	const figures = (instance) => walk(instance.output)
		.filter((node) => typeof node.type === 'function' && node.props.value !== undefined && node.props.label !== undefined)
		.flatMap((row) => walk(row.type(row.props)))
		.filter((node) => node.props?.className === 'td-value');

	it('draws its figures with the seed module Pill when the shell provides it', async () => {
		const { client, instance } = await open({ primitives: true });
		const pills = figures(instance);
		assert.equal(pills.length, 2, 'both headline figures come from the primitive');
		for (const pill of pills) assert.equal(pill.type, client.primitives.Pill);
	});

	it('reports the same figures either way, so the fallback is not a different page', async () => {
		const withSeed = await open({ primitives: true });
		const without = await open();
		assert.deepEqual(statsOf(withSeed.instance), statsOf(without.instance));
	});

	it('falls back to a plain span rather than blanking the row', async () => {
		const { instance } = await open();
		const pills = figures(instance);
		assert.equal(pills.length, 2);
		for (const pill of pills) assert.equal(typeof pill.type, 'function', 'the bundle substitutes its own component');
	});
});
