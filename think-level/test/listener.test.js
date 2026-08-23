/**
 * The one listener, driven.
 *
 * `agent/request` is a waterfall: the plugin awaits `next()` and then rewrites
 * what came back. So a test is just "hand it a resolved call configuration and
 * look at the one it returns" — no harness, no socket, no model.
 *
 * The interesting cases are all about restraint. The listener may only fill a
 * field nobody chose, may only send a level the model actually publishes, and
 * may never throw: it runs on every step of every agent, so a bad row in
 * settings.yaml has to cost the request nothing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { apply } from '../lib/index.js';

const LEVELS = [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }];

/**
 * Mount the plugin against a stub context and expose its request listener.
 * @param defaults - the configured table.
 * @param options - `reasoning` per model, or `fail` to make resolution throw.
 * @returns `{ send, calls, prepended }`.
 */
function mount(defaults, options = {}) {
	const handlers = [];
	const calls = [];
	const llm = {
		resolveModelInfo: async (provider, model) => {
			calls.push(`${provider}/${model}`);
			if (options.fail && calls.length <= (options.failTimes ?? Infinity)) throw new Error('provider unreachable');
			const reasoning = options.reasoning === undefined
				? { efforts: LEVELS, defaultEffort: 'high' }
				: options.reasoning[model];
			return reasoning === undefined ? { id: model } : { id: model, reasoning };
		},
	};
	const ctx = {
		on: (event, fn, prepend) => { handlers.push({ event, fn, prepend }); return () => {}; },
		get: (name) => (name === 'llm' ? (options.noLlm ? undefined : llm) : undefined),
		inject: () => {},
		effect: () => {},
		emit: () => {},
	};
	apply(ctx, { defaults });
	const entry = handlers.find((h) => h.event === 'agent/request');
	return {
		prepended: entry.prepend,
		calls,
		send: (resolved) => entry.fn({}, async () => resolved),
	};
}

const CALL = { provider: 'dgx', model: 'v4', messages: [] };

describe('agent/request', () => {
	it('runs outermost so its rewrite is the last word', () => {
		// Prepend is what puts this listener's post-next() rewrite after every
		// listener registered later, including the one that re-derives the
		// session's own effort on every step.
		assert.equal(mount([]).prepended, true);
	});

	it('fills the configured level when nothing else chose one', async () => {
		const { send } = mount([{ provider: 'dgx', model: 'v4', effort: 'low' }]);
		assert.equal((await send(CALL)).reasoningEffort, 'low');
	});

	it('leaves a level that was already chosen alone', async () => {
		const { send, calls } = mount([{ provider: 'dgx', model: 'v4', effort: 'low' }]);
		const out = await send({ ...CALL, reasoningEffort: 'high' });
		assert.equal(out.reasoningEffort, 'high', 'the session outranks the table');
		assert.deepEqual(calls, [], 'and it costs no round-trip to find out');
	});

	it('leaves a model with no row exactly as it found it', async () => {
		const { send } = mount([{ provider: 'dgx', model: 'other', effort: 'low' }]);
		const out = await send(CALL);
		assert.equal(out.reasoningEffort, undefined);
		assert.deepEqual(out, CALL, 'no opinion means no rewrite at all');
	});

	it('drops a level the model does not publish rather than killing the turn', async () => {
		// prepareCall rejects an unsupported id with UNSUPPORTED_REASONING_EFFORT,
		// so a stale row must cost the request nothing.
		const { send } = mount([{ provider: 'dgx', model: 'v4', effort: 'ultra' }]);
		assert.equal((await send(CALL)).reasoningEffort, undefined);
	});

	it('leaves a model that cannot think at all alone', async () => {
		const { send } = mount([{ provider: 'dgx', model: 'v4', effort: 'low' }], { reasoning: {} });
		assert.equal((await send(CALL)).reasoningEffort, undefined);
	});

	it('resolves each model once and reuses the answer', async () => {
		const { send, calls } = mount([{ provider: 'dgx', model: 'v4', effort: 'low' }]);
		await send(CALL);
		await send(CALL);
		await send(CALL);
		assert.deepEqual(calls, ['dgx/v4'], 'one round-trip, not one per step');
	});

	it('retries after a failed resolve instead of giving up on the model', async () => {
		// Caching the failure would turn one unreachable provider into a
		// permanently opinion-free model: the row would sit in the table
		// looking applied until the process restarted.
		const { send, calls } = mount([{ provider: 'dgx', model: 'v4', effort: 'low' }], { fail: true, failTimes: 1 });
		assert.equal((await send(CALL)).reasoningEffort, undefined, 'the failing step goes out unchanged');
		assert.equal((await send(CALL)).reasoningEffort, 'low', 'the next one gets the level');
		assert.deepEqual(calls, ['dgx/v4', 'dgx/v4']);
	});

	it('passes the request through untouched without an llm service', async () => {
		const { send } = mount([{ provider: 'dgx', model: 'v4', effort: 'low' }], { noLlm: true });
		assert.deepEqual(await send(CALL), CALL);
	});

	it('passes through a configuration with no provider or model', async () => {
		const { send } = mount([{ provider: 'dgx', model: 'v4', effort: 'low' }]);
		assert.deepEqual(await send({ messages: [] }), { messages: [] });
		assert.equal(await send(undefined), undefined);
	});
});
