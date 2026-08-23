/**
 * Declaring a model's levels into pi-ai's namespace.
 *
 * The two shapes are not a preference — `resolveRouteModels` refuses
 * `modelOverrides` beside a `models` list and refuses an override for a model
 * the installed catalog does not describe — so choosing the wrong one produces
 * a route that will not serve. And `applyPathOp` walks plain objects only, so
 * the `models` shape has to restate the whole list. These tests pin both.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	DEFAULT_EFFORTS,
	NO_ROUTE,
	THINKING_LEVELS,
	UNLISTED_MODEL,
	describeDeclaration,
	planDeclaration,
	validateEfforts,
} from '../lib/pi-ai-levels.js';

/** A route that spells its models out — the hand-declared endpoint case. */
const DECLARED = {
	providers: {
		dgx: {
			api: 'openai-completions',
			baseURL: 'http://spark:7200/v1',
			models: [
				{ id: 'v4-flash', name: 'V4 Flash', contextWindow: 245000 },
				{ id: 'gemma', name: 'Gemma', reasoningEfforts: false },
			],
		},
	},
};

/** A route the installed catalog describes — no list of its own. */
const CATALOGUED = { providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } } };

describe('validateEfforts', () => {
	it('rebuilds the map in level order, so the stored file reads like a scale', () => {
		const checked = validateEfforts({ high: 'high', off: 'none', low: 'low' });
		assert.equal(checked.ok, true);
		assert.deepEqual(Object.keys(checked.efforts), ['off', 'low', 'high']);
	});

	it('takes false, which is how a model says it cannot think at all', () => {
		assert.deepEqual(validateEfforts(false), { ok: true, efforts: false });
	});

	it('names the level it refuses rather than the whole payload', () => {
		assert.match(validateEfforts({ sideways: 'hard' }).error, /sideways/);
		// Only "off" may be empty: pi-ai reads a null as "send nothing", which
		// is a thinking level for exactly one level.
		assert.match(validateEfforts({ high: null }).error, /high/);
		assert.match(validateEfforts({ low: '' }).error, /low/);
	});

	it('refuses a declaration that offers nothing but off', () => {
		// pi-ai refuses it too; catching it here is what makes the message
		// about the declaration rather than about the route being unserviceable.
		assert.equal(validateEfforts({ off: 'none' }).ok, false);
		assert.equal(validateEfforts({}).ok, false);
		assert.equal(validateEfforts(null).ok, false);
		assert.equal(validateEfforts([]).ok, false);
	});

	it('offers the whole level vocabulary, and suggests the portable four', () => {
		assert.deepEqual(THINKING_LEVELS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
		// `off` is spelled `none` on the wire; the two are deliberately not the
		// same string, and getting that backwards is the classic hand-edit bug.
		assert.equal(DEFAULT_EFFORTS.off, 'none');
		assert.deepEqual(Object.keys(DEFAULT_EFFORTS), ['off', 'low', 'medium', 'high', 'max']);
		assert.equal(validateEfforts(DEFAULT_EFFORTS).ok, true);
	});
});

describe('describeDeclaration', () => {
	it('finds the entry on a route that lists its models', () => {
		assert.deepEqual(describeDeclaration(DECLARED, 'dgx', 'v4-flash'), { shape: 'models', declared: undefined });
		assert.deepEqual(describeDeclaration(DECLARED, 'dgx', 'gemma'), { shape: 'models', declared: false });
	});

	it('falls to modelOverrides on a route the catalog describes', () => {
		assert.deepEqual(describeDeclaration(CATALOGUED, 'openrouter', 'anything'), { shape: 'overrides', declared: undefined });
	});

	it('declines a route pi-ai does not serve, without pretending it could', () => {
		// The built-in DeepSeek adapter is not in this dict and owns its own
		// capability metadata; saying "no route" is the honest answer.
		assert.deepEqual(describeDeclaration(DECLARED, 'deepseek-official', 'v4-pro'), { shape: null, reason: NO_ROUTE });
		assert.deepEqual(describeDeclaration(DECLARED, 'dgx', 'not-listed'), { shape: null, reason: UNLISTED_MODEL });
		assert.deepEqual(describeDeclaration(undefined, 'dgx', 'v4-flash'), { shape: null, reason: NO_ROUTE });
	});
});

describe('planDeclaration', () => {
	it('restates the whole list to patch one entry, because no path walks an array', () => {
		const plan = planDeclaration(DECLARED, DECLARED, 'dgx', 'v4-flash', DEFAULT_EFFORTS);
		assert.deepEqual(plan.ops, [{
			op: 'set',
			path: ['providers', 'dgx', 'models'],
			value: [
				{ id: 'v4-flash', name: 'V4 Flash', contextWindow: 245000, reasoningEfforts: DEFAULT_EFFORTS },
				{ id: 'gemma', name: 'Gemma', reasoningEfforts: false },
			],
		}]);
	});

	it('leaves every other entry of that list exactly as it found it', () => {
		// The whole-array write is the one op here that could lose something
		// the user typed, so the untouched entries are the invariant.
		const plan = planDeclaration(DECLARED, DECLARED, 'dgx', 'gemma', null);
		assert.deepEqual(plan.ops[0].value[0], DECLARED.providers.dgx.models[0]);
		assert.deepEqual(plan.ops[0].value[1], { id: 'gemma', name: 'Gemma' });
	});

	it('writes one surgical path on a catalog-described route', () => {
		const plan = planDeclaration(CATALOGUED, CATALOGUED, 'openrouter', 'glm-5', DEFAULT_EFFORTS);
		assert.deepEqual(plan.ops, [{
			op: 'set',
			path: ['providers', 'openrouter', 'modelOverrides', 'glm-5', 'reasoningEfforts'],
			value: DEFAULT_EFFORTS,
		}]);
	});

	it('takes the emptied containers with it when the declaration is withdrawn', () => {
		const one = { providers: { openrouter: { modelOverrides: { 'glm-5': { reasoningEfforts: DEFAULT_EFFORTS } } } } };
		assert.deepEqual(planDeclaration(one, one, 'openrouter', 'glm-5', null).ops, [
			{ op: 'unset', path: ['providers', 'openrouter', 'modelOverrides'] },
		]);

		const two = {
			providers: {
				openrouter: {
					modelOverrides: {
						'glm-5': { reasoningEfforts: DEFAULT_EFFORTS },
						'other': { maxTokens: 100 },
					},
				},
			},
		};
		assert.deepEqual(planDeclaration(two, two, 'openrouter', 'glm-5', null).ops, [
			{ op: 'unset', path: ['providers', 'openrouter', 'modelOverrides', 'glm-5'] },
		]);

		// A sibling field on the same override is somebody's setting; only the
		// leaf goes.
		const kept = { providers: { openrouter: { modelOverrides: { 'glm-5': { reasoningEfforts: DEFAULT_EFFORTS, maxTokens: 100 } } } } };
		assert.deepEqual(planDeclaration(kept, kept, 'openrouter', 'glm-5', null).ops, [
			{ op: 'unset', path: ['providers', 'openrouter', 'modelOverrides', 'glm-5', 'reasoningEfforts'] },
		]);
	});

	it('patches the user\'s own list rather than the resolved one', () => {
		// Rewriting the resolved list would copy every field the composition
		// base contributes into settings.yaml, freezing values nobody typed.
		const user = { providers: { dgx: { models: [{ id: 'v4-flash' }, { id: 'gemma' }] } } };
		const plan = planDeclaration(DECLARED, user, 'dgx', 'v4-flash', DEFAULT_EFFORTS);
		assert.deepEqual(plan.ops[0].value, [{ id: 'v4-flash', reasoningEfforts: DEFAULT_EFFORTS }, { id: 'gemma' }]);
	});

	it('falls back to the resolved list when only the base lists that model', () => {
		// There is no way to patch one entry of an array without restating the
		// array, so a base-only list has to be materialized to be changed.
		const plan = planDeclaration(DECLARED, {}, 'dgx', 'v4-flash', DEFAULT_EFFORTS);
		assert.equal(plan.ops[0].value.length, 2);
		assert.deepEqual(plan.ops[0].value[0].reasoningEfforts, DEFAULT_EFFORTS);
	});

	it('refuses a route it cannot address instead of writing somewhere plausible', () => {
		assert.deepEqual(planDeclaration(DECLARED, DECLARED, 'deepseek-official', 'v4-pro', DEFAULT_EFFORTS), { ok: false, reason: NO_ROUTE });
		assert.deepEqual(planDeclaration(DECLARED, DECLARED, 'dgx', 'ghost', DEFAULT_EFFORTS), { ok: false, reason: UNLISTED_MODEL });
	});
});
