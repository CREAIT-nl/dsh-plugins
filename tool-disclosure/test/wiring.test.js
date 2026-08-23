/**
 * Wiring tests: drive `apply` against a stub Cordis context and assert what
 * the real `system-prompt/assemble` waterfall would carry into the request.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Config } from '../lib/catalog.js';
import { TOOL_DISCLOSURE_SETTINGS_NAMESPACE, apply } from '../lib/index.js';

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

const REGISTERED = [
	'bash',
	'web_fetch',
	'mcp__playwright__browser_navigate',
	'mcp__playwright__browser_click',
	'mcp__mem0__search_memory',
];

/**
 * A settings service stub: enough of one for `installSettingsSection` to
 * register a namespace over the row's config and notify on a write.
 */
function stubSettings() {
	const layers = new Map();
	return {
		writable: true,
		register(ns, _schema, options) {
			const layer = { base: options.base ?? {}, user: {}, watchers: [] };
			layers.set(ns, layer);
			return {
				get: () => ({ ...layer.base, ...layer.user }),
				watch(listener) {
					layer.watchers.push(listener);
					return () => {};
				},
			};
		},
		/** Write the user layer, as the settings page's POST would. */
		write(ns, patch) {
			const layer = layers.get(ns);
			layer.user = { ...layer.user, ...patch };
			for (const listener of layer.watchers) listener();
		},
	};
}

/**
 * Mount the plugin against a stub context and expose the surfaces the harness
 * drives: the prompt section, the assemble waterfall, the tool, and the
 * settings namespace the page writes.
 */
function harness(raw = { groups: [BROWSER, MEMORY], defer: ['browser', 'memory'] }, { mode = 'native', settings = stubSettings() } = {}) {
	const registered = new Map();
	const sections = [];
	const listeners = new Map();
	let names = [...REGISTERED];

	const ctx = {
		// `installSettingsSection` reads this when a watcher fires, to tell a
		// settings write apart from its own teardown.
		fiber: { state: 0 },
		tools: {
			register(definition) {
				registered.set(definition.name, definition);
				return () => registered.delete(definition.name);
			},
			// The registry's own view for a scope: every tool the agent could
			// call, whether or not this row advertises it.
			view() {
				return { visible: new Map(names.map((name) => [name, { name }])) };
			},
			modeFor() {
				return mode;
			},
		},
		systemPrompt: {
			section(definition) {
				sections.push(definition);
				return () => {};
			},
		},
		on(event, listener) {
			const bucket = listeners.get(event);
			if (bucket === undefined) listeners.set(event, [listener]);
			else bucket.push(listener);
			return () => {};
		},
		get(name) {
			if (name === 'settings') return settings ?? undefined;
			return ctx[name];
		},
		// Fires only when every named service is present, which is how the
		// harness treats an optional dependency — a headless run has no
		// `webServer`, and a deployment can have no `settings` service at all.
		inject(names_, callback) {
			if (names_.some((name) => ctx.get(name) === undefined)) return () => {};
			callback(Object.assign(Object.create(ctx), {
				settings,
				effect(factory) {
					factory();
					return () => {};
				},
			}));
			return () => {};
		},
	};

	apply(ctx, new Config(raw));

	return {
		registered,
		sections,
		/** Write the plugin's settings namespace, as the page would. */
		write(patch) {
			settings.write(TOOL_DISCLOSURE_SETTINGS_NAMESPACE, patch);
		},
		/** Set what the registry holds, e.g. an MCP server connecting late. */
		setRegistered(next) {
			names = next;
		},
		/** Render the catalog section exactly as assembly would. */
		catalog(agent) {
			const section = sections.find((entry) => entry.name === 'tools:deferred');
			if (section === undefined) return undefined;
			return section.text({ agent, scope: agent });
		},
		/** Run the assemble waterfall and return what reaches the request. */
		async assemble(agent) {
			const assembly = { tools: names.map((name) => ({ name })), sections: [], contexts: [], variables: {} };
			const listener = listeners.get('system-prompt/assemble')?.[0];
			if (listener === undefined) return assembly;
			const context = agent === undefined ? {} : { agent, scope: agent };
			return listener(assembly, context, () => Promise.resolve(assembly));
		},
		/** Call tool_search as the model would. */
		search(agent, query) {
			return registered.get('tool_search').execute({ query }, { agent });
		},
	};
}

/** Names of the tools that would reach one agent's request. */
async function advertised(bench, agent) {
	return (await bench.assemble(agent)).tools.map((tool) => tool.name);
}

describe('mounting', () => {
	it('registers the tool and the section when groups are configured', () => {
		const bench = harness();
		assert.equal(bench.registered.has('tool_search'), true);
		assert.equal(bench.sections.length, 1);
	});

	it('registers no tool when no group is configured', () => {
		// An unconfigured row must not cost a tool schema of its own, and a
		// `tool_search` whose only honest answer is "nothing is deferred" is
		// exactly the cost this package exists to remove.
		const bench = harness({ groups: [] });
		assert.equal(bench.registered.size, 0);
		assert.equal(bench.catalog({ id: 'a' }), '');
	});

	it('registers no tool when every switch is off', () => {
		const bench = harness({ groups: [BROWSER, MEMORY], defer: [] });
		assert.equal(bench.registered.size, 0);
	});

	it('works with no settings service at all, from the row config alone', async () => {
		// A headless deployment can have no settings provider mounted; the row
		// must still defer what its own config says.
		const bench = harness({ groups: [BROWSER, MEMORY], defer: ['browser', 'memory'] }, { settings: null });
		assert.equal(bench.registered.has('tool_search'), true);
		assert.deepEqual(await advertised(bench, { id: 'a' }), ['bash', 'web_fetch']);
	});
});

describe('the switches', () => {
	it('advertises a switched-off group in full and leaves the rest deferred', async () => {
		const bench = harness();
		bench.write({ defer: ['memory'] });
		assert.deepEqual(await advertised(bench, { id: 'a' }), [
			'bash',
			'web_fetch',
			'mcp__playwright__browser_navigate',
			'mcp__playwright__browser_click',
		]);
		const text = bench.catalog({ id: 'a' });
		assert.equal(text.includes('- browser'), false);
		assert.match(text, /- memory/);
	});

	it('applies a write without a restart, in both directions', async () => {
		const bench = harness();
		bench.write({ defer: [] });
		assert.deepEqual(await advertised(bench, { id: 'a' }), REGISTERED);
		bench.write({ defer: ['browser', 'memory'] });
		assert.deepEqual(await advertised(bench, { id: 'a' }), ['bash', 'web_fetch']);
	});

	it('drops tool_search once every group is off and brings it back on', () => {
		const bench = harness();
		bench.write({ defer: [] });
		assert.equal(bench.registered.has('tool_search'), false);
		bench.write({ defer: ['memory'] });
		assert.equal(bench.registered.has('tool_search'), true);
	});

	it('defers a group nothing in the patch annotates', async () => {
		// No patch entry and no globs: the id alone stands for the MCP server,
		// so a server that reconnects carrying more tools is still covered.
		const bench = harness({ groups: [] });
		assert.deepEqual(await advertised(bench, { id: 'a' }), REGISTERED);
		bench.write({ defer: ['playwright'] });
		assert.deepEqual(await advertised(bench, { id: 'a' }), ['bash', 'web_fetch', 'mcp__mem0__search_memory']);
	});

	it('names an unannotated group by its tools, since nobody wrote it a summary', async () => {
		const bench = harness({ groups: [] });
		bench.write({ defer: ['playwright'] });
		const text = bench.catalog({ id: 'a' });
		assert.match(text, /- playwright/);
		assert.match(text, /browser_navigate/);
	});

	it('lets an annotation win the id against the group it would be derived from', async () => {
		// The authored globs and the authored summary are somebody's decision;
		// a derived guess wearing the same id would shadow both.
		const bench = harness();
		bench.write({ defer: ['browser'] });
		assert.match(bench.catalog({ id: 'a' }), /- browser \(2 tools\): Drive a real Chrome/);
	});

	it('refuses a glob written where a group id belongs', async () => {
		// A discovered group's patterns are derived from its id, so `*` would
		// compile to a matcher claiming everything: one line in a hand-edited
		// settings file, and the model loses every tool at once. The settings
		// route drops these too, but nothing makes a hand edit pass through it.
		const bench = harness({ groups: [] });
		bench.write({ defer: ['*'] });
		assert.deepEqual(await advertised(bench, { id: 'a' }), REGISTERED);
		assert.equal(bench.registered.has('tool_search'), false);
		assert.equal(bench.catalog({ id: 'a' }), '');
	});

	it('keeps tool_search advertised even when a switch names it', async () => {
		// Hand-written config can ask for it; the plugin still refuses, because
		// honouring it would leave no call able to load anything back.
		const bench = harness({ groups: [] });
		bench.setRegistered([...REGISTERED, 'tool_search']);
		bench.write({ defer: ['tool_search', 'playwright'] });
		assert.equal(bench.registered.has('tool_search'), true);
		assert.ok((await advertised(bench, { id: 'a' })).includes('tool_search'));
	});

	it('leaves a group the settings layer never mentions where the patch put it', async () => {
		// The user layer holds only the switch list, so the annotations — and a
		// `defer` the patch ships as its own default — stay authored there and
		// are not masked by a stale copy in the user layer.
		const bench = harness();
		bench.write({});
		assert.deepEqual(await advertised(bench, { id: 'a' }), ['bash', 'web_fetch']);
	});
});

describe('assembly filtering', () => {
	it('removes deferred tools and keeps everything else', async () => {
		const bench = harness();
		assert.deepEqual(await advertised(bench, { id: 'a' }), ['bash', 'web_fetch']);
	});

	it('returns the assembly untouched when nothing is deferred', async () => {
		const bench = harness();
		bench.setRegistered(['bash', 'web_fetch']);
		const agent = { id: 'a' };
		const assembly = await bench.assemble(agent);
		assert.deepEqual(assembly.tools.map((tool) => tool.name), ['bash', 'web_fetch']);
	});

	it('defers nothing for an assembly with no agent', async () => {
		// A non-agent assembly has nowhere to record a load, so a catalog it
		// could never act on would be a dead end.
		const bench = harness();
		assert.deepEqual(await advertised(bench, undefined), REGISTERED);
		assert.equal(bench.catalog(undefined), '');
	});

	it('defers nothing under a Code Mode presentation', async () => {
		// There the schemas reach the model through the generated SDK section,
		// which this row cannot filter — so it must not claim to have.
		const bench = harness({ groups: [BROWSER, MEMORY] }, { mode: 'code' });
		assert.deepEqual(await advertised(bench, { id: 'a' }), REGISTERED);
		assert.equal(bench.catalog({ id: 'a' }), '');
	});

	it('keeps a tool named by the keep list visible', async () => {
		const bench = harness({ groups: [BROWSER, MEMORY], defer: ['browser', 'memory'], keep: ['mcp__playwright__browser_navigate'] });
		assert.deepEqual(await advertised(bench, { id: 'a' }), [
			'bash',
			'web_fetch',
			'mcp__playwright__browser_navigate',
		]);
	});
});

describe('catalog', () => {
	it('names each deferred group with its live tool count', () => {
		const text = harness().catalog({ id: 'a' });
		assert.match(text, /- browser \(2 tools\)/);
		assert.match(text, /- memory \(1 tool\)/);
	});

	it('counts only what is registered now, so a late MCP server is not promised early', () => {
		const bench = harness();
		bench.setRegistered(['bash']);
		assert.equal(bench.catalog({ id: 'a' }), '');
	});
});

describe('tool_search', () => {
	it('loads a group and advertises it from the next assembly', async () => {
		const bench = harness();
		const agent = { id: 'a' };
		const result = await bench.search(agent, 'browser');
		assert.deepEqual(result.loaded, ['browser']);
		assert.deepEqual(result.tools, ['mcp__playwright__browser_navigate', 'mcp__playwright__browser_click']);
		assert.deepEqual(await advertised(bench, agent), [
			'bash',
			'web_fetch',
			'mcp__playwright__browser_navigate',
			'mcp__playwright__browser_click',
		]);
	});

	it('drops the loaded group from the catalog and leaves the rest', async () => {
		const bench = harness();
		const agent = { id: 'a' };
		await bench.search(agent, 'browser');
		const text = bench.catalog(agent);
		assert.equal(text.includes('- browser'), false);
		assert.match(text, /- memory/);
	});

	it('resolves free text to the group it describes', async () => {
		const bench = harness();
		const result = await bench.search({ id: 'a' }, 'I need to click a button on a page');
		assert.deepEqual(result.loaded, ['browser']);
	});

	it('loads nothing and names the options when the query matches no group', async () => {
		const bench = harness();
		const agent = { id: 'a' };
		const result = await bench.search(agent, 'compile the kernel');
		assert.deepEqual(result.loaded, []);
		assert.match(result.message, /browser, memory/);
		assert.deepEqual(await advertised(bench, agent), ['bash', 'web_fetch']);
	});

	it('says so plainly when nothing is deferred', async () => {
		const bench = harness();
		bench.setRegistered(['bash']);
		const result = await bench.search({ id: 'a' }, 'browser');
		assert.deepEqual(result.loaded, []);
		assert.match(result.message, /Nothing is deferred/);
	});

	it('loads every group for the reveal-all query', async () => {
		const bench = harness();
		const agent = { id: 'a' };
		await bench.search(agent, 'all');
		assert.deepEqual(await advertised(bench, agent), REGISTERED);
		assert.equal(bench.catalog(agent), '');
	});

	it('keeps one agent load out of another agent session', async () => {
		const bench = harness();
		const mine = { id: 'a' };
		const theirs = { id: 'b' };
		await bench.search(mine, 'browser');
		assert.equal((await advertised(bench, mine)).length, 4);
		assert.deepEqual(await advertised(bench, theirs), ['bash', 'web_fetch']);
	});

	it('refuses a call with no owning agent rather than loading globally', async () => {
		// defineTool wraps execution, so the refusal surfaces as a rejection.
		const bench = harness();
		await assert.rejects(() => bench.registered.get('tool_search').execute({ query: 'browser' }, {}), /owning agent/);
	});
});
