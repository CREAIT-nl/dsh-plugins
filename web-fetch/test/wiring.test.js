/**
 * Manifest wiring: the bundle patch is what makes `dsh plugin add` mount this
 * provider at all, and the row it inserts has to be the one the seam registers.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LOCAL_FETCH_PROVIDER_ID, LocalFetchProvider, apply, inject, name } from '../lib/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const manifest = JSON.parse(read('package.json'));
const patch = read('cordis.patch.yml');

describe('the package manifest', () => {
	it('ships every file it lists', () => {
		for (const file of manifest.files) assert.ok(existsSync(join(ROOT, file)), `listed but missing: ${file}`);
	});

	// Without this the package installs and mounts nothing: `dsh plugin add`
	// records the dependency, and only a `dsh.bundle` manifest field makes the
	// profile apply the patch that inserts the row.
	it('points the harness at its bundle patch, and publishes it', () => {
		assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
		assert.ok(manifest.files.includes('cordis.patch.yml'), 'the patch would not be published');
	});

	it('is named as the row the bundle patch inserts', () => {
		assert.match(patch, new RegExp(`name: '${manifest.name.replace('/', '\\/')}'`));
		assert.match(patch, /id: web-fetch/);
		assert.equal(name, 'web-fetch');
	});
});

describe('the row the bundle mounts', () => {
	it('registers the provider and nothing else', () => {
		const registered = [];
		const ctx = {
			web: {
				registerFetchProvider(provider) {
					registered.push(provider);
					return () => {};
				},
				registerSearchProvider() {
					assert.fail('a fetch provider must not touch the search side of the seam');
				},
			},
		};
		apply(ctx, {});
		assert.equal(registered.length, 1);
		assert.equal(registered[0].id, LOCAL_FETCH_PROVIDER_ID);
		assert.ok(registered[0] instanceof LocalFetchProvider);
		assert.deepEqual(inject, ['web']);
	});

	// dsh ships no fetch provider, so `local` is normally the only one
	// registered and `resolveProvider` selects it without being told. That is
	// what lets the bundle mount the row without also rewriting the `web` row's
	// config, which a patch would assign outright rather than merge.
	it('is usable without being named in `web.fetchProvider`', () => {
		const provider = new LocalFetchProvider(() => ({}));
		assert.equal(provider.available(), typeof globalThis.fetch === 'function');
	});
});
