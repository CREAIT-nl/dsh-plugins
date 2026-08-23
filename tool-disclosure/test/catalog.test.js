/** Pure-logic tests for glob matching, partitioning, catalog text and query resolution. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	Config,
	autoIdFor,
	compileDiscovered,
	compileGroups,
	compilePattern,
	discoverGroups,
	groupOf,
	partition,
	renderCatalog,
	resolve,
	summarizeTools,
	withSummaries,
} from '../lib/catalog.js';

const BROWSER = {
	id: 'browser',
	match: ['mcp__playwright__*'],
	summary: 'Drive a real Chrome: navigate, click, fill forms, screenshot, read the console.',
};

const MEMORY = {
	id: 'memory',
	match: ['mcp__mem0__*'],
	summary: 'Search and write long-term memories about prior work.',
};

/** Validate a raw config through the real schema, as the loader would. */
function compile(raw) {
	const config = new Config(raw);
	return {
		groups: compileGroups(config.groups),
		keep: config.keep.map(compilePattern),
	};
}

/** Minimal tool records: partition only ever reads `.name`. */
function tools(...names) {
	return names.map((name) => ({ name }));
}

describe('compilePattern', () => {
	it('anchors the glob at both ends', () => {
		const matcher = compilePattern('mcp__playwright__*');
		assert.equal(matcher.test('mcp__playwright__browser_click'), true);
		assert.equal(matcher.test('x_mcp__playwright__browser_click'), false);
	});

	it('matches a name with no wildcard exactly', () => {
		const matcher = compilePattern('bash');
		assert.equal(matcher.test('bash'), true);
		assert.equal(matcher.test('bash_output'), false);
	});

	it('treats regex metacharacters as literals', () => {
		// A pattern carrying `.` is an author typo, not a character class: it
		// must not quietly match every one-character substitution.
		const matcher = compilePattern('web.fetch');
		assert.equal(matcher.test('web.fetch'), true);
		assert.equal(matcher.test('web_fetch'), false);
	});

	it('supports a wildcard in the middle and several per pattern', () => {
		const matcher = compilePattern('mcp__*__browser_*');
		assert.equal(matcher.test('mcp__playwright__browser_click'), true);
		assert.equal(matcher.test('mcp__playwright__list_tabs'), false);
	});
});

describe('groupOf', () => {
	it('returns the first group claiming a name, so config order is the tiebreak', () => {
		const groups = compileGroups([
			{ id: 'first', match: ['mcp__*'], summary: 'everything mcp' },
			{ id: 'second', match: ['mcp__mem0__*'], summary: 'memory' },
		]);
		assert.equal(groupOf('mcp__mem0__search_memory', groups).id, 'first');
	});

	it('returns undefined for an unclaimed name', () => {
		const { groups } = compile({ groups: [BROWSER] });
		assert.equal(groupOf('bash', groups), undefined);
	});
});

describe('partition', () => {
	it('withholds claimed tools and passes everything else through', () => {
		const { groups, keep } = compile({ groups: [BROWSER] });
		const { visible, hidden } = partition(
			tools('bash', 'mcp__playwright__browser_click', 'web_fetch', 'mcp__playwright__browser_type'),
			groups,
			new Set(),
			keep,
		);
		assert.deepEqual(visible.map((tool) => tool.name), ['bash', 'web_fetch']);
		assert.deepEqual(hidden.get('browser').map((tool) => tool.name), [
			'mcp__playwright__browser_click',
			'mcp__playwright__browser_type',
		]);
	});

	it('passes a loaded group straight through and withholds nothing for it', () => {
		const { groups, keep } = compile({ groups: [BROWSER, MEMORY] });
		const { visible, hidden } = partition(
			tools('mcp__playwright__browser_click', 'mcp__mem0__search_memory'),
			groups,
			new Set(['browser']),
			keep,
		);
		assert.deepEqual(visible.map((tool) => tool.name), ['mcp__playwright__browser_click']);
		assert.equal(hidden.has('browser'), false);
		assert.equal(hidden.get('memory').length, 1);
	});

	it('lets a keep glob win against the group that claims the name', () => {
		const { groups, keep } = compile({
			groups: [BROWSER],
			keep: ['mcp__playwright__browser_navigate'],
		});
		const { visible, hidden } = partition(
			tools('mcp__playwright__browser_navigate', 'mcp__playwright__browser_click'),
			groups,
			new Set(),
			keep,
		);
		assert.deepEqual(visible.map((tool) => tool.name), ['mcp__playwright__browser_navigate']);
		assert.deepEqual(hidden.get('browser').map((tool) => tool.name), ['mcp__playwright__browser_click']);
	});

	it('preserves the order the assembly handed it', () => {
		const { groups, keep } = compile({ groups: [BROWSER] });
		const { visible } = partition(tools('c', 'a', 'b'), groups, new Set(), keep);
		assert.deepEqual(visible.map((tool) => tool.name), ['c', 'a', 'b']);
	});
});

describe('renderCatalog', () => {
	it('renders nothing when no group is holding anything back', () => {
		const { groups } = compile({ groups: [BROWSER] });
		assert.equal(renderCatalog(new Map(), groups), '');
	});

	it('names the tool that loads a group, so the catalog is self-describing', () => {
		const { groups, keep } = compile({ groups: [BROWSER] });
		const { hidden } = partition(tools('mcp__playwright__browser_click'), groups, new Set(), keep);
		assert.match(renderCatalog(hidden, groups), /tool_search/);
	});

	it('renders one counted line per deferred group, in config order', () => {
		const { groups, keep } = compile({ groups: [BROWSER, MEMORY] });
		const { hidden } = partition(
			tools('mcp__mem0__search_memory', 'mcp__playwright__browser_click', 'mcp__playwright__browser_type'),
			groups,
			new Set(),
			keep,
		);
		const lines = renderCatalog(hidden, groups).split('\n').filter((line) => line.startsWith('- '));
		assert.deepEqual(lines, [
			`- browser (2 tools): ${BROWSER.summary}`,
			`- memory (1 tool): ${MEMORY.summary}`,
		]);
	});

	it('omits a group whose tools are all loaded or not registered', () => {
		const { groups, keep } = compile({ groups: [BROWSER, MEMORY] });
		const { hidden } = partition(tools('mcp__mem0__search_memory'), groups, new Set(), keep);
		const text = renderCatalog(hidden, groups);
		assert.equal(text.includes('- browser'), false);
		assert.equal(text.includes('- memory'), true);
	});
});

describe('resolve', () => {
	const { groups } = compile({ groups: [BROWSER, MEMORY] });

	it('matches a group id exactly, whatever the casing', () => {
		assert.deepEqual(resolve('Browser', groups), ['browser']);
	});

	it('loads everything for the reveal-all words', () => {
		assert.deepEqual(resolve('all', groups), ['browser', 'memory']);
		assert.deepEqual(resolve('*', groups), ['browser', 'memory']);
	});

	it('scores a free-text query against the id and the summary, best first', () => {
		assert.deepEqual(resolve('click a form on a page in chrome', groups), ['browser']);
		assert.deepEqual(resolve('search my long-term memories', groups), ['memory']);
	});

	it('ranks a query that touches both groups by how much it touches each', () => {
		assert.deepEqual(resolve('navigate and click a form, then write memories', groups), ['browser', 'memory']);
	});

	it('returns nothing for a query that matches nothing, rather than guessing', () => {
		// "the" appears in the browser summary; scoring it would make this a
		// match for a query about neither group.
		assert.deepEqual(resolve('compile the kernel', groups), []);
	});

	it('ignores terms too short to mean anything', () => {
		// "in"/"a" appear inside half the catalog as substrings; matching on
		// them would make every query resolve to every group.
		assert.deepEqual(resolve('in a', groups), []);
	});

	it('ignores a query made only of function words', () => {
		assert.deepEqual(resolve('what can you use this for', groups), []);
	});

	it('returns nothing for an empty query', () => {
		assert.deepEqual(resolve('   ', groups), []);
	});
});

describe('Config', () => {
	it('defaults both lists to empty, so an unconfigured row defers nothing', () => {
		const config = new Config({});
		assert.deepEqual(config.groups, []);
		assert.deepEqual(config.keep, []);
	});

	it('rejects a group missing the summary the model would have to decide on', () => {
		assert.throws(() => new Config({ groups: [{ id: 'browser', match: ['x*'] }] }));
	});
});

describe('autoIdFor', () => {
	it('buckets an MCP tool under its server, which is a grouping already made', () => {
		// A server's tools arrive and leave together, and a session either needs
		// that server or does not.
		assert.equal(autoIdFor('mcp__playwright__browser_click'), 'playwright');
		assert.equal(autoIdFor('mcp__mem0__search_memory'), 'mem0');
	});

	it('leaves a harness tool standing alone rather than inventing a bucket', () => {
		// `bash` and `web_fetch` have nothing to do with each other; grouping
		// them would be this plugin claiming a relationship it cannot support.
		assert.equal(autoIdFor('bash'), 'bash');
		assert.equal(autoIdFor('mcp__weird'), 'mcp__weird');
	});
});

describe('summarizeTools', () => {
	const tool = (name, description = '') => ({ name, description });

	it('lists the short names, which is where most of the signal is', () => {
		const summary = summarizeTools([tool('mcp__playwright__browser_click'), tool('mcp__playwright__browser_type')]);
		assert.equal(summary, 'browser_click, browser_type');
	});

	it('falls back to a lone tool own first sentence', () => {
		assert.equal(summarizeTools([tool('bash', 'Run a shell command. Long tail here.')]), 'Run a shell command.');
		assert.equal(summarizeTools([tool('bash')]), 'bash');
	});

	it('caps a long list and says how many it left out', () => {
		const many = Array.from({ length: 40 }, (_, i) => tool(`mcp__x__tool_number_${i}`));
		const summary = summarizeTools(many);
		assert.ok(summary.length <= 260, summary);
		assert.match(summary, /, and \d+ more$/);
	});

	it('describes an empty group as nothing rather than as a stray comma', () => {
		assert.equal(summarizeTools([]), '');
	});
});

describe('discoverGroups', () => {
	const registry = [
		{ name: 'bash', description: 'Run a shell command.' },
		{ name: 'mcp__playwright__browser_click', description: '' },
		{ name: 'mcp__playwright__browser_type', description: '' },
		{ name: 'mcp__mem0__search_memory', description: '' },
	];
	const configured = compileGroups([{ id: 'browser', match: ['mcp__playwright__*'], summary: 'Chrome.' }]);

	it('leaves what a configured group claims to that group', () => {
		assert.deepEqual(discoverGroups(registry, configured).map((group) => group.id), ['bash', 'mem0']);
	});

	it('buckets everything when nothing is configured', () => {
		assert.deepEqual(discoverGroups(registry, []).map((group) => group.id), ['bash', 'playwright', 'mem0']);
	});

	it('gives tool_search no row, since a switch for it would be a trapdoor', () => {
		// It is the only call that loads a group back. Defer it and the model
		// loses every group at once with nothing left to undo it.
		const withSearch = [...registry, { name: 'tool_search', description: 'Load a deferred group.' }];
		assert.equal(discoverGroups(withSearch, []).some((group) => group.id === 'tool_search'), false);
	});

	it('carries patterns derived from the id, not from the tools it found', () => {
		// So an MCP server that reconnects with three more tools is covered by
		// the same group, and one that is down at boot still defers on return.
		const [, playwright] = discoverGroups(registry, []);
		assert.equal(playwright.patterns.some((pattern) => pattern.test('mcp__playwright__browser_navigate')), true);
	});
});

describe('compileDiscovered and withSummaries', () => {
	it('compiles a switched-on id with no registry to consult', () => {
		assert.deepEqual(compileDiscovered(['mem0', 'mem0']).map((group) => group.id), ['mem0']);
	});

	it('fills the summary from what the group is holding back right now', () => {
		// Derived at read time, not stored: a summary written at boot would keep
		// promising a tool the server has since dropped.
		const groups = compileDiscovered(['playwright']);
		const hidden = new Map([['playwright', [{ name: 'mcp__playwright__browser_click', description: '' }]]]);
		assert.equal(withSummaries(groups, hidden)[0].summary, 'browser_click');
		assert.equal(withSummaries(groups, new Map())[0].summary, '');
	});

	it('leaves an authored summary alone, since somebody chose those words', () => {
		const groups = compileGroups([{ id: 'browser', match: ['x*'], summary: 'Drive a real Chrome.' }]);
		assert.equal(withSummaries(groups, new Map())[0].summary, 'Drive a real Chrome.');
	});
});
