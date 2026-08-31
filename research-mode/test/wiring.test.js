/**
 * The claims this package makes about itself.
 *
 * Every assertion here corresponds to a way the plugin can fail to load or
 * silently fail to be a mode — a manifest naming a file that does not ship, a
 * preset row naming an entry point that is not exported, an `inject` on the
 * roster half that would make the whole install wait on a service the host plane
 * does not publish. None of these produce a stack trace; they produce a harness
 * where the mode is simply not in the picker, which is the hardest kind of bug
 * to notice.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, it } from 'node:test';

import { RESEARCH_SETTINGS_NAMESPACE } from '../lib/config.js';
import * as roster from '../lib/index.js';
import { CONFIG_ROUTE } from '../lib/settings-routes.js';
import { RESEARCH_SCRIPT } from '../lib/script.js';
import * as tool from '../lib/tool.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Git checkouts on Windows carry CRLF (`core.autocrlf`), while every regex
// below anchors on `\n`. Normalizing at the single read site keeps the tests
// byte-honest on Linux and alive on Windows.
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const manifest = JSON.parse(read('package.json'));
const patch = read('cordis.patch.yml');
const preset = read('presets/research/agent.cordis.yml');
const presetMeta = read('presets/research/preset.yml');

describe('the package manifest', () => {
	it('ships every file it lists, and lists every module it ships', () => {
		for (const file of manifest.files) assert.ok(existsSync(join(ROOT, file)), `listed but missing: ${file}`);

		const listed = new Set(manifest.files);
		for (const module of ['index', 'tool', 'config', 'settings-routes', 'script', 'schemas', 'render', 'home', 'preset-install']) {
			assert.ok(listed.has(`lib/${module}.js`), `lib/${module}.js would not be published`);
		}
		assert.ok(listed.has('client/client.cjs'), 'the browser half would not be published');
	});

	it('exports every subpath a preset or a consumer names', async () => {
		for (const [subpath, target] of Object.entries(manifest.exports)) {
			const file = typeof target === 'string' ? target : target.default;
			assert.ok(existsSync(join(ROOT, file)), `${subpath} points at a missing file`);
			if (file.endsWith('.js')) await import(new URL(file, `file://${ROOT}/`));
		}
	});

	it('points the harness at its bundle patch', () => {
		assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
		assert.ok(manifest.files.includes('cordis.patch.yml'));
	});
});

describe('the roster half', () => {
	// The flaw this pins down: `inject` is all-or-nothing in Cordis and gates
	// loading. The Web surface disables `workflow-worker-thread` on the host
	// plane, so a roster row declaring `workflowEngine` would wait forever, never
	// run `apply`, never install the preset — and the mode would never appear.
	it('injects nothing, so nothing can stop it installing the preset', () => {
		assert.equal(roster.inject, undefined);
	});

	// What the roster half is allowed to reach for, and nothing else. The width
	// pin needs a persisted namespace and a route to move it, and both arrive
	// through SCOPED injects — so a deployment without `settings` or without a
	// web server still installs the preset, which is the property the row above
	// is really protecting. Anything model-facing (`tools`, `commands`, a prompt
	// section) would show up here as an untouched member turning up in the list.
	it('reaches for settings and webServer, scoped, and for nothing else', () => {
		// `apply` installs the preset for real, and with no `home` that is the
		// caller's actual dsh home. Point it somewhere disposable: a unit test
		// has no business writing into the machine's live harness state.
		const original = process.env.DSH_HOME;
		process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'research-mode-wiring-'));

		const touched = [];
		const injected = [];
		const ctx = new Proxy(
			{
				logger: { info() {}, warn() {} },
				inject(services) {
					injected.push(services);
				},
			},
			{
				get(target, property) {
					if (property in target) return target[property];
					touched.push(String(property));
					return () => {};
				},
			},
		);

		try {
			roster.apply(ctx);
		} finally {
			rmSync(process.env.DSH_HOME, { recursive: true, force: true });
			if (original === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = original;
		}

		assert.deepEqual(touched, [], `roster plane touched: ${touched.join(', ')}`);
		assert.deepEqual(injected, [['settings'], ['webServer']]);
	});

	it('serves the width pin on its own namespaced route', () => {
		assert.equal(RESEARCH_SETTINGS_NAMESPACE, 'dsh-research-mode');
		assert.equal(CONFIG_ROUTE, `/api/${RESEARCH_SETTINGS_NAMESPACE}/config`);
	});

	it('is named as the row the bundle patch inserts', () => {
		assert.match(patch, new RegExp(`name: '${manifest.name.replace('/', '\\/')}'`));
		assert.match(patch, /id: research-mode/);
		assert.equal(roster.name, 'research-mode');
	});
});

describe('the agent half', () => {
	it('injects exactly the registries it uses', () => {
		assert.deepEqual(tool.inject, ['tools', 'workflowEngine']);
		assert.equal(tool.name, 'research-mode-tool');
	});

	it('is mounted by the preset under an exported subpath', () => {
		assert.match(preset, /name: '@creait\/dsh-research-mode\/tool'/);
		assert.ok('./tool' in manifest.exports);
	});

	// A row that provides a Service must sit in a realm or `dsh-agent-presets`
	// refuses the mount — and the realm is entry-local, so the consumer has to be
	// inside the same group as the provider.
	it('sits inside the same isolate realm as the engine that serves it', () => {
		const group = preset.slice(preset.indexOf('- id: research'), preset.indexOf('- id: tool-web'));
		assert.match(group, /name: cordis:group/);
		assert.match(group, /isolate:\n\s+workflowEngine: true/);
		assert.match(group, /name: '@deepseek-ai\/dsh-workflow-worker-thread'/);
		assert.match(group, /name: '@creait\/dsh-research-mode\/tool'/);
	});

	it('leaves the model-authored orchestration tool out', () => {
		assert.doesNotMatch(preset, /dsh-tool-workflow/);
	});

	// The loop's researchers are spawned onto this composition, so this row is
	// what decides whether they can research at all.
	it('gives the preset web search and page fetching', () => {
		assert.match(preset, /name: '@deepseek-ai\/dsh-tool-web'\n\s+config:\n\s+fetch: true/);
	});

	it('keeps the report out of the pruner, whose default would cut it', () => {
		assert.match(preset, /thresholdChars: 32768/);
	});

	it('gives the agent no shell', () => {
		assert.doesNotMatch(preset, /tool-bash|tool-pwsh/);
	});
});

describe('the browser half', () => {
	const client = read('client/client.cjs');

	// The loader checks `factories.has(row.id)` after the bundle runs, and the
	// row id is the PACKAGE name. Registering under the short name loads the
	// file and then fails with "loaded without registering", which reads like a
	// syntax error and is not one.
	it('registers under the full package name the loader looks for', () => {
		assert.match(client, new RegExp(`id: '${manifest.name.replace('/', '\\/')}'`));
		assert.equal(manifest.exports['./client'], './client/client.cjs');
		assert.equal(manifest.dsh.client.platform, 'web');
	});

	// The whole argument for this package is that a session on another mode is
	// unchanged. A composer control that drew itself everywhere would break that
	// claim in the one place the user actually looks.
	it('gates the control on the session\'s preset', () => {
		assert.match(client, /const PRESET_ID = 'research'/);
		assert.match(client, /agentPreset/);
		assert.match(client, /if \(!mine\) return null/);
	});

	it('talks to the route the host half serves', () => {
		assert.match(client, new RegExp(`CONFIG_ROUTE = '${CONFIG_ROUTE}'`));
	});

	// The browser cannot see the preset row's `maxWidth` — that is agent-plane
	// config — so the field's ceiling is a mirror, and a mirror that drifts
	// silently refuses a width the tool would have accepted.
	it('mirrors the preset row\'s width ceiling', () => {
		const ceiling = Number(client.match(/const MAX_WIDTH = (\d+)/)[1]);
		const shipped = Number(preset.match(/maxWidth: (\d+)/)[1]);
		assert.equal(ceiling, shipped);
	});
});

describe('the preset', () => {
	it('is written in English throughout', () => {
		for (const [label, text] of [
			['agent.cordis.yml', preset],
			['preset.yml', presetMeta],
		]) {
			const cjk = text.match(/[　-〿぀-ヿ一-鿿＀-￯]/g) ?? [];
			assert.deepEqual(cjk, [], `${label} carries CJK: ${cjk.join('')}`);
		}
	});

	it('names itself for the picker', () => {
		assert.match(presetMeta, /^name: /m);
		assert.match(presetMeta, /^description: /m);
	});
});

describe('the workflow script', () => {
	it('parses under the engine\'s exact wrapper', () => {
		assert.doesNotThrow(() => new vm.Script(`(async () => {\n${RESEARCH_SCRIPT}\n})()`));
	});

	// The worker strips and validates `meta` itself; a `meta` in the body is a
	// META_INVALID at start, which is fatal before any agent runs.
	it('carries no meta block of its own', () => {
		assert.doesNotMatch(RESEARCH_SCRIPT, /export\s+const\s+meta/);
	});

	it('uses only the globals the sandbox provides', () => {
		// `vm.createContext({})` has the JS built-ins and nothing else — no
		// require, no process, no fetch, no timers.
		for (const forbidden of ['require(', 'process.', 'fetch(', 'setTimeout(', 'import(']) {
			assert.equal(RESEARCH_SCRIPT.includes(forbidden), false, `script reaches for ${forbidden}`);
		}
	});

	// Anything outside this set throws UNSUPPORTED_OPTION, which is fatal — and
	// it fails at the first agent call, after the run has already started.
	it('passes only the agent options the engine accepts', () => {
		const allowed = new Set(['label', 'phase', 'schema', 'provider', 'model']);
		const options = RESEARCH_SCRIPT.match(/\{\s*label:[\s\S]*?\}/g) ?? [];
		assert.ok(options.length > 0, 'no agent() options found to check');
		for (const block of options) {
			for (const [, key] of block.matchAll(/(?:^|[{,]\s*)([a-zA-Z]+):/g)) {
				assert.ok(allowed.has(key), `unsupported agent() option: ${key}`);
			}
		}
	});
});
