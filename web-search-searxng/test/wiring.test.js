/**
 * Manifest wiring, and the property that makes a bundle mount safe: an
 * unconfigured row must not make `ctx.web` ambiguous.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	Config,
	SEARXNG_DEFAULT_BASE_URL,
	SEARXNG_PROVIDER_ID,
	SearxngSearchProvider,
	apply,
	inject,
	name,
	resolveOptions,
} from '../lib/index.js';

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
		assert.match(patch, /id: web-search-searxng/);
		assert.equal(name, 'web-search-searxng');
	});
});

describe('the row the bundle mounts', () => {
	it('registers the provider and nothing else', () => {
		const registered = [];
		const ctx = {
			web: {
				registerSearchProvider(provider) {
					registered.push(provider);
					return () => {};
				},
				registerFetchProvider() {
					assert.fail('a search provider must not touch the fetch side of the seam');
				},
			},
		};
		apply(ctx, new Config({}));
		assert.equal(registered.length, 1);
		assert.equal(registered[0].id, SEARXNG_PROVIDER_ID);
		assert.deepEqual(inject, ['web']);
	});

	// The flaw this pins down: `resolveProvider` throws WEB_PROVIDER_AMBIGUOUS
	// when two usable search providers are registered and `web.searchProvider`
	// names neither. dsh registers its own, so a default instance URL here would
	// mean installing this package broke the search that already worked — before
	// the user had configured anything. An empty default is what makes the row
	// inert until it is pointed at an instance.
	it('is unavailable until it is pointed at an instance', () => {
		assert.equal(SEARXNG_DEFAULT_BASE_URL, '');
		const unconfigured = new SearxngSearchProvider(() => resolveOptions(new Config({})));
		assert.equal(unconfigured.available(), false);

		const configured = new SearxngSearchProvider(() => resolveOptions(new Config({ baseURL: 'http://localhost:8080' })));
		assert.equal(configured.available(), true);
	});
});
