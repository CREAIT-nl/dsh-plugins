/**
 * The unpin: taking one field back off the harness.
 *
 * `agent-default-model.reasoningEffort` is written by the harness on every
 * model switch (the resolved selection carries the adapter's materialized
 * default) and read by every session created afterwards. Left alone it shadows
 * the whole table, so the plugin unsets it — which means these tests care about
 * exactly three things: that it only ever touches that one field, that it does
 * not spin on the event its own write emits, and that a failure to write is
 * survivable rather than fatal.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_DEFAULT_MODEL_NAMESPACE, installGlobalEffortUnpin, unpinGlobalEffort } from '../lib/global-default.js';

/**
 * A settings service holding one namespace's user layer.
 * @param user - the raw user override layer, or undefined for none.
 * @param options - `fail` to make writes reject.
 * @returns `{ settings, writes, user }`.
 */
function stubSettings(user, options = {}) {
	const writes = [];
	const state = { user };
	const settings = {
		describe: () => [
			{ ns: 'dsh-think-level', value: { defaults: [] }, revision: 1 },
			{
				ns: AGENT_DEFAULT_MODEL_NAMESPACE,
				value: { provider: 'dgx', model: 'v4', ...state.user },
				...state.user === undefined ? {} : { user: state.user },
				revision: 7,
			},
		],
		mutate: async (ns, ops) => {
			writes.push({ ns, ops });
			if (options.fail) throw new Error('read-only settings');
			for (const op of ops) if (op.op === 'unset') {
				const { [op.path[0]]: _dropped, ...rest } = state.user ?? {};
				state.user = rest;
			}
		},
	};
	return { settings, writes, state };
}

describe('unpinGlobalEffort', () => {
	it('unsets the pinned effort and nothing else', async () => {
		const { settings, writes, state } = stubSettings({ provider: 'dgx', model: 'v4', reasoningEffort: 'high' });
		assert.equal(await unpinGlobalEffort(settings), true);
		assert.deepEqual(writes, [{
			ns: AGENT_DEFAULT_MODEL_NAMESPACE,
			ops: [{ op: 'unset', path: ['reasoningEffort'] }],
		}]);
		assert.deepEqual(state.user, { provider: 'dgx', model: 'v4' }, 'the selection itself survives');
	});

	it('writes nothing when the field is already absent', async () => {
		const { settings, writes } = stubSettings({ provider: 'dgx', model: 'v4' });
		assert.equal(await unpinGlobalEffort(settings), false);
		assert.deepEqual(writes, []);
	});

	it('writes nothing when the namespace has no user layer at all', async () => {
		const { settings, writes } = stubSettings(undefined);
		assert.equal(await unpinGlobalEffort(settings), false);
		assert.deepEqual(writes, []);
	});

	it('survives a composition with no settings service', async () => {
		assert.equal(await unpinGlobalEffort(undefined), false);
	});
});

describe('installGlobalEffortUnpin', () => {
	/**
	 * Mount the unpin against a stub context wired to a stub settings service.
	 * @param settings - the settings service to hand back from `ctx.get`.
	 * @returns `{ emit, errors }`.
	 */
	function mount(settings) {
		const listeners = [];
		const errors = [];
		const ctx = {
			on: (event, fn) => { listeners.push({ event, fn }); return () => {}; },
			get: (name) => (name === 'settings' ? settings : undefined),
		};
		installGlobalEffortUnpin(ctx, (error) => errors.push(String(error)));
		const entry = listeners.find((l) => l.event === 'settings/document-updated');
		return { emit: (ns) => entry.fn(ns, 1), errors, listening: entry !== undefined };
	}

	it('unpins once at startup', async () => {
		const { settings, writes } = stubSettings({ provider: 'dgx', model: 'v4', reasoningEffort: 'high' });
		mount(settings);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(writes.length, 1);
	});

	it('unpins again after the harness writes the namespace back', async () => {
		const { settings, writes, state } = stubSettings({ provider: 'dgx', model: 'v4' });
		const { emit } = mount(settings);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(writes, [], 'nothing pinned yet');
		// A model switch: the harness saves the resolved selection, adapter
		// default and all.
		state.user = { provider: 'dgx', model: 'other', reasoningEffort: 'max' };
		emit(AGENT_DEFAULT_MODEL_NAMESPACE);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(writes.length, 1);
		assert.deepEqual(state.user, { provider: 'dgx', model: 'other' });
	});

	it('settles instead of spinning on the event its own write emits', async () => {
		const { settings, writes } = stubSettings({ provider: 'dgx', model: 'v4', reasoningEffort: 'high' });
		const { emit } = mount(settings);
		await new Promise((resolve) => setImmediate(resolve));
		// Replay the emit the write itself would cause, a few times over.
		for (let pass = 0; pass < 5; pass += 1) {
			emit(AGENT_DEFAULT_MODEL_NAMESPACE);
			await new Promise((resolve) => setImmediate(resolve));
		}
		assert.equal(writes.length, 1, 'the read guard stops the second pass');
	});

	it('ignores every other namespace', async () => {
		const { settings, writes } = stubSettings({ provider: 'dgx', model: 'v4', reasoningEffort: 'high' });
		const { emit } = mount(settings);
		await new Promise((resolve) => setImmediate(resolve));
		writes.length = 0;
		emit('llm-pi-ai');
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(writes, []);
	});

	it('reports a failed write instead of throwing into the settings emit', async () => {
		const { settings } = stubSettings({ provider: 'dgx', model: 'v4', reasoningEffort: 'high' }, { fail: true });
		const { emit, errors } = mount(settings);
		await new Promise((resolve) => setImmediate(resolve));
		assert.doesNotThrow(() => emit(AGENT_DEFAULT_MODEL_NAMESPACE));
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(errors.length >= 1, 'the failure is logged');
		assert.match(errors[0], /read-only settings/);
	});
});
