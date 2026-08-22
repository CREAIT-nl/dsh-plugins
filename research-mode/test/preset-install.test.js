/**
 * Getting the mode onto disk, and knowing when not to.
 *
 * The interesting case is the third boot, not the first: the preset root is
 * writable precisely so a mode can be tuned, which means the installer is
 * routinely looking at a file someone has edited. Overwriting it on upgrade
 * would be a silent data loss, and the tests below are mostly about that line —
 * rewrite what we wrote, keep what they wrote, and never throw either way.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { dshHome } from '../lib/home.js';
import { installPresets } from '../lib/preset-install.js';

const scratch = mkdtempSync(join(tmpdir(), 'research-mode-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
/** A fresh dsh home plus a shipped-preset tree, both throwaway. */
function fixture(presets = { research: { 'preset.yml': 'name: Research\n', 'agent.cordis.yml': 'plugins: {}\n' } }) {
	counter += 1;
	const home = join(scratch, `home-${counter}`);
	const source = join(scratch, `src-${counter}`);
	for (const [id, files] of Object.entries(presets)) {
		mkdirSync(join(source, id), { recursive: true });
		for (const [file, body] of Object.entries(files)) writeFileSync(join(source, id, file), body, 'utf8');
	}
	return { home, source, installed: (id, file) => join(home, '.agent-presets', id, file) };
}

describe('installPresets', () => {
	it('installs the shipped preset into the writable root', () => {
		const { home, source, installed } = fixture();
		const results = installPresets({ home, source });

		assert.deepEqual(results, [{ id: 'research', action: 'installed' }]);
		assert.equal(readFileSync(installed('research', 'preset.yml'), 'utf8'), 'name: Research\n');
		assert.equal(readFileSync(installed('research', 'agent.cordis.yml'), 'utf8'), 'plugins: {}\n');
	});

	it('is a no-op on the next boot', () => {
		const { home, source } = fixture();
		installPresets({ home, source });
		assert.deepEqual(installPresets({ home, source }), [{ id: 'research', action: 'current' }]);
	});

	it('updates an unmodified preset when the package ships a new one', () => {
		const { home, source, installed } = fixture();
		installPresets({ home, source });

		writeFileSync(join(source, 'research', 'preset.yml'), 'name: Research v2\n', 'utf8');
		assert.deepEqual(installPresets({ home, source }), [{ id: 'research', action: 'updated' }]);
		assert.equal(readFileSync(installed('research', 'preset.yml'), 'utf8'), 'name: Research v2\n');
	});

	it('never overwrites a preset the user has edited', () => {
		const { home, source, installed } = fixture();
		installPresets({ home, source });
		writeFileSync(installed('research', 'agent.cordis.yml'), 'plugins: { mine: true }\n', 'utf8');

		// Even with a new version shipped, their copy wins.
		writeFileSync(join(source, 'research', 'preset.yml'), 'name: Research v2\n', 'utf8');
		assert.deepEqual(installPresets({ home, source }), [{ id: 'research', action: 'kept' }]);
		assert.equal(readFileSync(installed('research', 'agent.cordis.yml'), 'utf8'), 'plugins: { mine: true }\n');
	});

	it('says so, once, when it keeps a local edit', () => {
		const { home, source, installed } = fixture();
		installPresets({ home, source });
		writeFileSync(installed('research', 'preset.yml'), 'name: Mine\n', 'utf8');

		const info = [];
		installPresets({ home, source, logger: { info: (message) => info.push(message) } });
		assert.equal(info.length, 1);
		assert.match(info[0], /local edits/);
	});

	it('leaves a pre-existing preset of the same name alone', () => {
		const { home, source, installed } = fixture();
		mkdirSync(join(home, '.agent-presets', 'research'), { recursive: true });
		writeFileSync(installed('research', 'preset.yml'), 'name: Theirs\n', 'utf8');
		writeFileSync(installed('research', 'agent.cordis.yml'), 'plugins: {}\n', 'utf8');

		assert.deepEqual(installPresets({ home, source }), [{ id: 'research', action: 'kept' }]);
		assert.equal(readFileSync(installed('research', 'preset.yml'), 'utf8'), 'name: Theirs\n');
	});

	it('installs over a half-written preset, which is not an edit', () => {
		const { home, source, installed } = fixture();
		mkdirSync(join(home, '.agent-presets', 'research'), { recursive: true });
		writeFileSync(installed('research', 'preset.yml'), 'name: partial\n', 'utf8');

		assert.deepEqual(installPresets({ home, source }), [{ id: 'research', action: 'installed' }]);
		assert.equal(existsSync(installed('research', 'agent.cordis.yml')), true);
	});

	it('skips a shipped directory that is not a complete preset', () => {
		const { home, source } = fixture({
			research: { 'preset.yml': 'name: Research\n', 'agent.cordis.yml': 'plugins: {}\n' },
			broken: { 'preset.yml': 'name: Broken\n' },
		});

		assert.deepEqual(installPresets({ home, source }), [{ id: 'research', action: 'installed' }]);
		assert.equal(existsSync(join(home, '.agent-presets', 'broken')), false);
	});

	it('ignores directory names that are not usable preset ids', () => {
		const { home, source } = fixture({
			'Not Valid': { 'preset.yml': 'x\n', 'agent.cordis.yml': 'y\n' },
			'-leading': { 'preset.yml': 'x\n', 'agent.cordis.yml': 'y\n' },
		});

		assert.deepEqual(installPresets({ home, source }), []);
	});

	it('installs every shipped preset', () => {
		const { home, source } = fixture({
			research: { 'preset.yml': 'a\n', 'agent.cordis.yml': 'b\n' },
			'research-lite': { 'preset.yml': 'c\n', 'agent.cordis.yml': 'd\n' },
		});

		const ids = installPresets({ home, source })
			.map((result) => result.id)
			.sort();
		assert.deepEqual(ids, ['research', 'research-lite']);
	});

	it('returns nothing when the package ships no presets at all', () => {
		const { home } = fixture();
		assert.deepEqual(installPresets({ home, source: join(scratch, 'does-not-exist') }), []);
	});

	it('reports a failure instead of throwing it into the harness', () => {
		const { home, source } = fixture();
		const root = join(home, '.agent-presets');
		mkdirSync(root, { recursive: true });
		chmodSync(root, 0o500);

		const warnings = [];
		let results;
		try {
			results = installPresets({ home, source, logger: { warn: (message) => warnings.push(message) } });
		} finally {
			chmodSync(root, 0o700);
		}

		assert.equal(results[0].id, 'research');
		assert.equal(results[0].action, 'failed');
		assert.match(warnings[0], /could not install agent preset "research"/);
	});

	it('ships the research preset this package actually claims to ship', () => {
		const { home } = fixture();
		const results = installPresets({ home });
		assert.deepEqual(
			results.map((result) => result.id),
			['research'],
		);
		assert.match(readFileSync(join(home, '.agent-presets', 'research', 'preset.yml'), 'utf8'), /Research mode/);
	});
});

describe('dshHome', () => {
	const original = process.env.DSH_HOME;
	before(() => {
		delete process.env.DSH_HOME;
	});
	after(() => {
		if (original === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = original;
	});

	it('honours DSH_HOME when the harness sets it', () => {
		process.env.DSH_HOME = '/somewhere/else';
		assert.equal(dshHome(), '/somewhere/else');
		delete process.env.DSH_HOME;
	});

	it('falls back to ~/.dsh', () => {
		assert.match(dshHome(), /\.dsh$/);
	});
});
