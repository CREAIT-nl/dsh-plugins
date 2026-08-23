/**
 * The two gates, mounted together.
 *
 * `queue.test.js` covers the line; this covers what the plugin puts in it. The
 * bug that motivated the file is the one a unit test of either half in
 * isolation cannot see: the spawn gate and the stream limiter were both
 * counting the same subagent, so one live child cost two slots and a limit of
 * three ran one child at a time. Every test here is about a count.
 *
 * `apply` is driven through a stub context — the handlers it registers are
 * plain functions, so the whole thing runs without a harness, a socket, or a
 * model.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { apply } from '../lib/index.js';

const PROVIDER = 'dgx';
const MODEL = 'deepseek-v4-flash';

/**
 * Mount the plugin against a stub context and expose its two gates.
 * @param settings - plugin config; `limits` defaults to one model.
 * @returns `{ spawn, stream }` drivers plus the raw handler map.
 */
function mount(settings = {}) {
	const handlers = new Map();
	const ctx = {
		on: (event, fn) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(fn);
			return () => {};
		},
		get: () => undefined,
		inject: () => {},
		effect: () => {},
		emit: () => {},
	};
	apply(ctx, {
		limits: [{ provider: PROVIDER, model: MODEL, max: 3 }],
		// Short by default: a `deny` in these tests means "waited the whole
		// timeout and no slot freed", which is the only way a spawn now fails.
		queueTimeoutMs: 50,
		maxQueued: 64,
		...settings,
	});
	const preExecute = handlers.get('tools/pre-execute')[0];
	const limiter = handlers.get('llm/stream')[0];

	/** Invoke a spawn tool as `agent` would. Resolves to the pipeline decision. */
	const spawn = (options = {}) => preExecute(
		{
			name: options.name ?? 'subagent',
			agent: { options: { provider: PROVIDER, model: MODEL } },
			...options.exec,
		},
		async () => ({ kind: 'allow' }),
	);

	/**
	 * Start a session generating and leave it generating.
	 * @returns `{ started, stop }` — `started` resolves once the first chunk is
	 *   through the limiter, `stop` ends the stream and frees the slot.
	 */
	const stream = (sessionId) => {
		let release = () => {};
		const held = new Promise((resolve) => { release = resolve; });
		const iterator = limiter(
			{ provider: PROVIDER, model: MODEL, sessionId },
			async function* () { yield { type: 'text' }; await held; },
		);
		return {
			started: iterator.next(),
			stop: async () => { release(); await iterator.return?.(); },
		};
	};

	return { handlers, spawn, stream, limiter, preExecute };
}

/**
 * Resolve to `'pending'` if a promise has not settled shortly.
 * @param promise - the promise under test.
 * @returns the settled value, or the string `'pending'`.
 */
function within(promise) {
	return Promise.race([
		promise,
		new Promise((resolve) => { setTimeout(() => resolve('pending'), 30); }),
	]);
}

describe('spawn gate and stream limiter, together', () => {
	it('lets `max` tool-spawned children all generate at once', async () => {
		// The regression, and the reason the spawn gate holds no slot. It used
		// to reserve one per admitted spawn and hold it until the child settled,
		// while the child separately took a slot of its own the moment it
		// generated. At max: 3, three spawns reserved all three slots and then
		// their own three children queued behind them — nothing generated until
		// the whole fan-out timed out.
		const gen = mount({ queueTimeoutMs: 5000 });

		for (const n of [1, 2, 3]) {
			assert.equal((await gen.spawn()).kind, 'allow', `spawn ${n} admitted`);
		}
		const children = ['child-1', 'child-2', 'child-3'].map((id) => gen.stream(id));
		for (const [at, child] of children.entries()) {
			assert.notEqual(await within(child.started), 'pending', `child ${at + 1} generates`);
		}
		for (const child of children) await child.stop();
	});

	it('caps distinct generating sessions at the limit', async () => {
		const gen = mount();
		const live = ['a', 'b', 'c'].map((id) => gen.stream(id));
		for (const one of live) await one.started;

		assert.equal((await gen.spawn()).kind, 'deny', 'no room at three');

		await live[0].stop();
		assert.equal((await gen.spawn()).kind, 'allow', 'a finished stream frees its slot');
		for (const one of live.slice(1)) await one.stop();
	});

	it('does not count one session twice for re-entering', async () => {
		// A session that streams, tool-calls, and streams again is one session
		// generating, not two.
		const gen = mount();
		const first = gen.stream('same');
		await first.started;
		const second = gen.stream('same');
		await second.started;

		assert.equal((await gen.spawn()).kind, 'allow', 'one session, one slot');
		await second.stop();
		await first.stop();
	});

	it('lets a waiting spawn through when a slot frees', async () => {
		const gen = mount({ queueTimeoutMs: 5000 });
		const live = ['a', 'b', 'c'].map((id) => gen.stream(id));
		for (const one of live) await one.started;

		const waiting = gen.spawn();
		const settled = await Promise.race([
			waiting.then(() => 'settled'),
			new Promise((resolve) => { setTimeout(() => resolve('waiting'), 20); }),
		]);
		assert.equal(settled, 'waiting', 'the spawn waits rather than failing');

		await live[0].stop();
		assert.equal((await waiting).kind, 'allow', 'and is admitted once there is room');
		for (const one of live.slice(1)) await one.stop();
	});

	it('denies a spawn only after its wait runs out', async () => {
		const gen = mount({ queueTimeoutMs: 20 });
		const live = ['a', 'b', 'c'].map((id) => gen.stream(id));
		for (const one of live) await one.started;

		const decision = await gen.spawn();
		assert.equal(decision.kind, 'deny');
		assert.match(String(decision.reason), /generation limit \(3 in flight, limit 3\)/);
		for (const one of live) await one.stop();
	});

	it('ignores tools that are not spawns, and models with no limit', async () => {
		const gen = mount();
		const live = ['a', 'b', 'c'].map((id) => gen.stream(id));
		for (const one of live) await one.started;

		assert.equal((await gen.spawn({ name: 'read_file' })).kind, 'allow', 'not a spawn tool');
		assert.equal((await gen.spawn({ name: 'subagent_fork' })).kind, 'deny', 'fork is a spawn tool');

		const unlimited = mount({ limits: [] });
		assert.equal((await unlimited.spawn()).kind, 'allow', 'no limit configured');
		for (const one of live) await one.stop();
	});
});
