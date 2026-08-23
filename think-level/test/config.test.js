/**
 * The table, normalized.
 *
 * `resolveConfig` is the boundary between "whatever is in settings.yaml" and
 * the lookup the request listener does on every step, so the tests are about
 * the two ways a hand-edited file goes wrong: a row that is missing a field,
 * and the same model written twice.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { effortFor, keyOf, resolveConfig } from '../lib/config.js';

describe('resolveConfig', () => {
	it('keeps complete rows verbatim', () => {
		const rows = [{ provider: 'dgx', model: 'v4-flash', effort: 'high' }];
		assert.deepEqual(resolveConfig({ defaults: rows }).defaults, rows);
	});

	it('drops a row missing any field instead of keying it on the empty string', () => {
		// A row with no model would match nothing, which looks exactly like a
		// row that works right up until you wonder why the model never thinks.
		const resolved = resolveConfig({
			defaults: [
				{ provider: '', model: 'v4', effort: 'high' },
				{ provider: 'dgx', model: '', effort: 'high' },
				{ provider: 'dgx', model: 'v4', effort: '' },
				{ provider: 'dgx', model: 'v4', effort: 'low' },
			],
		});
		assert.deepEqual(resolved.defaults, [{ provider: 'dgx', model: 'v4', effort: 'low' }]);
	});

	it('lets the last write win for a duplicated pair', () => {
		const resolved = resolveConfig({
			defaults: [
				{ provider: 'dgx', model: 'v4', effort: 'high' },
				{ provider: 'dgx', model: 'v4', effort: 'off' },
			],
		});
		assert.deepEqual(resolved.defaults, [{ provider: 'dgx', model: 'v4', effort: 'off' }]);
	});

	it('reads a missing, empty or malformed table as no opinion', () => {
		for (const input of [undefined, null, {}, { defaults: null }, { defaults: [null, 7, 'x'] }]) {
			assert.deepEqual(resolveConfig(input).defaults, []);
		}
	});
});

describe('effortFor', () => {
	const config = resolveConfig({
		defaults: [
			{ provider: 'dgx', model: 'v4', effort: 'high' },
			{ provider: 'pi', model: 'v4', effort: 'low' },
		],
	});

	it('matches on the provider AND the model, never on either alone', () => {
		assert.equal(effortFor(config, 'dgx', 'v4'), 'high');
		assert.equal(effortFor(config, 'pi', 'v4'), 'low');
		assert.equal(effortFor(config, 'dgx', 'v3'), undefined);
		assert.equal(effortFor(config, 'other', 'v4'), undefined);
	});

	it('separates the two fields with a character no id can contain', () => {
		// Without a separator that cannot appear in an id, `a` + `bc` and
		// `ab` + `c` would be the same row.
		assert.notEqual(keyOf('a', 'bc'), keyOf('ab', 'c'));
		assert.equal(effortFor(resolveConfig({ defaults: [{ provider: 'a', model: 'bc', effort: 'high' }] }), 'ab', 'c'), undefined);
	});
});
