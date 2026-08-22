/**
 * The admission queue, which is the piece that turns a refusal into a wait.
 *
 * Concurrency code is where the interesting behaviour is all in the cases
 * nobody hits by hand: two waiters woken by one freed slot, a waiter that
 * aborts while queued, a limit raised while a line is standing. Each of those
 * is a way to hand out a slot that does not exist, or to strand a caller
 * forever, so each gets a test.
 *
 * Time is injected rather than real — a test that sleeps for the 120s timeout
 * is a test nobody runs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CapacityTimeout, makeSlotQueue } from '../lib/queue.js';

/** A clock the test advances by hand. */
function clock() {
	let next = 1;
	const timers = new Map();
	return {
		timers: {
			setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, at: ms }); return id; },
			clearTimeout: (id) => { timers.delete(id); },
		},
		tick(ms) {
			for (const [id, timer] of [...timers.entries()]) {
				if (timer.at > ms) { timer.at -= ms; continue; }
				timers.delete(id);
				timer.fn();
			}
		},
		get armed() { return timers.size; },
	};
}

/**
 * A queue over a simple integer occupancy model.
 * @param max - the limit, or -1 for unlimited.
 */
function fixture(max) {
	const time = clock();
	const state = { held: 0 };
	const queue = makeSlotQueue({
		capacity: () => (state.max < 0 ? { free: 0, unlimited: true } : { free: state.max - state.held, unlimited: false }),
		timers: time.timers,
	});
	state.max = max;
	const take = (options = {}) => queue.acquire('k', () => { state.held += 1; }, { timeoutMs: 1000, ...options });
	const give = () => { state.held -= 1; queue.release('k'); };
	return { queue, state, time, take, give };
}

const settled = () => new Promise((resolve) => { setImmediate(resolve); });

describe('the slot queue: admission', () => {
	it('admits immediately while there is room', async () => {
		const { take, state } = fixture(2);
		await take();
		await take();
		assert.equal(state.held, 2);
	});

	it('counts the claim before considering the next caller', async () => {
		// The bug this guards: resolving a waiter and letting it claim later
		// leaves a window in which the slot reads as free to everyone else.
		const { take, state } = fixture(1);
		await take();
		const queued = take();
		let admitted = false;
		queued.then(() => { admitted = true; });
		await settled();
		assert.equal(admitted, false);
		assert.equal(state.held, 1);
	});

	it('wakes exactly one waiter per freed slot', async () => {
		const { take, give, state } = fixture(1);
		await take();
		const a = take();
		const b = take();
		const done = [];
		a.then(() => done.push('a'));
		b.then(() => done.push('b'));
		give();
		await settled();
		assert.deepEqual(done, ['a'], 'one slot freed must not wake both');
		assert.equal(state.held, 1);
		give();
		await settled();
		assert.deepEqual(done, ['a', 'b']);
	});

	it('serves waiters first-in-first-out', async () => {
		const { take, give } = fixture(1);
		await take();
		const order = [];
		for (const label of ['a', 'b', 'c']) take().then(() => order.push(label));
		for (let i = 0; i < 3; i += 1) { give(); await settled(); }
		assert.deepEqual(order, ['a', 'b', 'c']);
	});

	it('makes an arrival queue behind existing waiters rather than jumping', async () => {
		// Without this, a steady arrival rate starves whoever is already waiting.
		const { take, give } = fixture(1);
		await take();
		const order = [];
		take().then(() => order.push('waiting'));
		give();
		take().then(() => order.push('arrived-later'));
		await settled();
		assert.deepEqual(order, ['waiting']);
	});

	it('never queues when the model is unlimited', async () => {
		const { take, state } = fixture(-1);
		for (let i = 0; i < 20; i += 1) await take();
		assert.equal(state.held, 20);
	});
});

describe('the slot queue: bounded waiting', () => {
	it('gives up after the timeout, with the capacity error', async () => {
		const { take, time } = fixture(1);
		await take();
		const queued = take({ timeoutMs: 1000 });
		time.tick(1000);
		await assert.rejects(queued, (error) => error instanceof CapacityTimeout && /waited 1000ms/.test(error.message));
	});

	it('leaves the line on timeout, so a later release is not spent on a ghost', async () => {
		const { take, give, time, queue } = fixture(1);
		await take();
		const abandoned = take({ timeoutMs: 1000 });
		const patient = take({ timeoutMs: 9000 });
		time.tick(1000);
		await assert.rejects(abandoned, CapacityTimeout);
		assert.equal(queue.waiting('k'), 1);
		give();
		await settled();
		await patient;
	});

	it('disarms its timer once admitted, so a late tick cannot fire', async () => {
		const { take, give, time } = fixture(1);
		await take();
		const queued = take({ timeoutMs: 1000 });
		give();
		await queued;
		assert.equal(time.armed, 0);
	});

	it('waits indefinitely when the timeout is disabled', async () => {
		const { take, time } = fixture(1);
		await take();
		take({ timeoutMs: 0 });
		assert.equal(time.armed, 0, 'no timer is armed at all');
	});

	it('refuses at the door once the line is full', async () => {
		const { take } = fixture(1);
		await take();
		take({ maxQueued: 2 });
		take({ maxQueued: 2 });
		await assert.rejects(take({ maxQueued: 2 }), (error) => error instanceof CapacityTimeout && /queue full: 2 waiting/.test(error.message));
	});
});

describe('the slot queue: cancellation', () => {
	it('rejects a caller that aborts while queued, with the abort reason', async () => {
		const { take } = fixture(1);
		await take();
		const controller = new AbortController();
		const queued = take({ signal: controller.signal });
		const reason = new Error('caller went away');
		controller.abort(reason);
		await assert.rejects(queued, (error) => error === reason);
	});

	it('does not consume a slot for an aborted waiter', async () => {
		const { take, give, state } = fixture(1);
		await take();
		const controller = new AbortController();
		const abandoned = take({ signal: controller.signal });
		abandoned.catch(() => {});
		const patient = take();
		controller.abort(new Error('gone'));
		give();
		await settled();
		await patient;
		assert.equal(state.held, 1, 'the freed slot went to the caller still waiting');
	});

	it('refuses an already-aborted caller without queueing it', async () => {
		const { take, queue } = fixture(1);
		await take();
		const controller = new AbortController();
		controller.abort(new Error('too late'));
		await assert.rejects(take({ signal: controller.signal }));
		assert.equal(queue.waiting('k'), 0);
	});

	it('drops its abort listener on admission, so a later abort is inert', async () => {
		const { take, give } = fixture(1);
		await take();
		const controller = new AbortController();
		const queued = take({ signal: controller.signal });
		give();
		await queued;
		controller.abort(new Error('after the fact'));
		// Nothing to assert beyond "this did not throw": an un-removed listener
		// would call `done(reject)` on an already-settled waiter.
		assert.ok(true);
	});
});

describe('the slot queue: a limit that moves', () => {
	it('drains the line when the limit is raised in the settings UI', async () => {
		const { take, state, queue } = fixture(1);
		await take();
		const waiting = [take(), take()];
		state.max = 3;
		queue.refresh();
		await Promise.all(waiting);
		assert.equal(state.held, 3);
	});

	it('drains everything when the limit is turned off entirely', async () => {
		const { take, state, queue } = fixture(1);
		await take();
		const waiting = [take(), take(), take()];
		state.max = -1;
		queue.refresh();
		await Promise.all(waiting);
		assert.equal(state.held, 4);
	});

	it('keeps waiters queued when the limit is lowered', async () => {
		const { take, state, queue, give } = fixture(2);
		await take();
		await take();
		const queued = take();
		let admitted = false;
		queued.then(() => { admitted = true; }).catch(() => {});
		state.max = 1;
		queue.refresh();
		await settled();
		assert.equal(admitted, false);
		// One release still leaves 1 held against a limit of 1: still no room.
		give();
		await settled();
		assert.equal(admitted, false);
	});

	it('reports its depth, which is what the stats route shows', async () => {
		const { take, queue } = fixture(1);
		await take();
		take(); take();
		assert.equal(queue.waiting('k'), 2);
		assert.deepEqual(queue.keys(), ['k']);
	});

	it('forgets an empty line rather than leaking a key per model', async () => {
		const { take, give, queue } = fixture(1);
		await take();
		const queued = take();
		give();
		await queued;
		assert.deepEqual(queue.keys(), []);
	});
});
