/**
 * The FIFO admission queue behind the concurrency limit.
 *
 * The limit used to be enforced by refusal: at capacity a request was answered
 * with `GEN_CAPACITY_EXCEEDED` and it was the caller's problem. That is the
 * right answer for a caller that can do something else, and the wrong one for
 * every caller this plugin actually has. A research fan-out hands eight
 * researchers to the runtime at once because eight questions is the brief; five
 * of them bouncing does not make the brief smaller, it just spends the retry
 * budget re-asking. So capacity is now something a request WAITS for.
 *
 * What this module does NOT own is the count. Occupancy lives in the limiter's
 * `active` map (session ids, so one session generating ten times in a row is
 * one), and this queue reads it through the `capacity` probe it is given. It
 * owns only the line: who is waiting, in what order, and what ends their wait.
 *
 * Three things end a wait, and all three are bounded on purpose:
 *   - a slot frees        -> the head of the line claims it, synchronously
 *   - `timeoutMs` elapses -> reject, and the limiter yields the same
 *                            GEN_CAPACITY_EXCEEDED it always did. The fallback
 *                            is the old behaviour, so a queue that never drains
 *                            is no worse than not queueing at all.
 *   - the caller aborts   -> reject, and the waiter leaves the line
 *
 * The bound matters more than it looks. An unbounded queue in front of a slow
 * backend is a memory leak that presents as a hang, and every waiter is holding
 * a live request. `maxQueued` refuses at the door instead.
 *
 * @module @creait/dsh-gen-limit/queue
 */

/** Raised when a wait ends without a slot. The limiter turns it into a chunk. */
export class CapacityTimeout extends Error {
	constructor(message) {
		super(message);
		this.name = 'CapacityTimeout';
	}
}

/**
 * Build a slot queue.
 *
 * @param options - `{ capacity, timers }`. `capacity(key)` reports
 *   `{ free, unlimited }` for a provider/model key, read live so an edit in the
 *   settings UI takes effect on the next pump rather than the next restart.
 *   `timers` is `{ setTimeout, clearTimeout }`, injectable so tests need no
 *   wall clock.
 * @returns the queue.
 */
export function makeSlotQueue(options) {
	const capacity = options.capacity;
	const timers = options.timers ?? { setTimeout, clearTimeout };
	/** key -> waiters, oldest first. */
	const lines = new Map();

	/**
	 * Hand slots to whoever is waiting, while there are slots and waiters.
	 *
	 * Each waiter claims its slot INSIDE this loop, synchronously, before the
	 * next `capacity` probe. Resolving first and letting the woken caller claim
	 * later would let the whole line wake on one freed slot and every one of
	 * them see it as free.
	 * @param key - the provider/model key whose line to drain.
	 */
	function pump(key) {
		const line = lines.get(key);
		if (line === undefined) return;
		while (line.length > 0) {
			const state = capacity(key);
			if (!state.unlimited && state.free <= 0) break;
			line.shift().admit();
		}
		if (line.length === 0) lines.delete(key);
	}

	return {
		/**
		 * Wait for a slot, then claim it.
		 *
		 * Resolves only once `claim` has run, so the caller is already counted
		 * when it continues — there is no window in which it is running but
		 * invisible to the next capacity probe.
		 *
		 * @param key - provider/model key.
		 * @param claim - runs at admission to take the slot (adds the session).
		 *   A waiter that only wants to be paced, and takes no slot of its own,
		 *   passes a no-op. Must be synchronous.
		 * @param waitOptions - `{ timeoutMs, maxQueued, signal, message }`.
		 * @returns a promise that resolves on admission.
		 * @throws {CapacityTimeout} when the wait times out or the line is full.
		 */
		acquire(key, claim, waitOptions = {}) {
			const state = capacity(key);
			const line = lines.get(key) ?? [];
			// Jump the line only when nobody is in it. Taking a free slot while
			// others wait would starve the head of the queue under steady load.
			if ((state.unlimited || state.free > 0) && line.length === 0) {
				claim();
				return Promise.resolve();
			}

			const maxQueued = waitOptions.maxQueued ?? 64;
			if (line.length >= maxQueued) {
				return Promise.reject(new CapacityTimeout(`${waitOptions.message ?? 'at capacity'} (queue full: ${line.length} waiting)`));
			}

			const signal = waitOptions.signal;
			if (signal?.aborted === true) return Promise.reject(signal.reason ?? new Error('aborted'));

			return new Promise((resolve, reject) => {
				let settled = false;
				const waiter = {};

				const leave = () => {
					const current = lines.get(key);
					const at = current === undefined ? -1 : current.indexOf(waiter);
					if (at >= 0) current.splice(at, 1);
				};

				const done = (fn) => (value) => {
					if (settled) return;
					settled = true;
					if (timer !== undefined) timers.clearTimeout(timer);
					if (signal !== undefined) signal.removeEventListener('abort', onAbort);
					fn(value);
				};

				const onAbort = () => { leave(); done(reject)(signal.reason ?? new Error('aborted')); };

				const timer = waitOptions.timeoutMs === undefined || waitOptions.timeoutMs <= 0
					? undefined
					: timers.setTimeout(() => {
						leave();
						done(reject)(new CapacityTimeout(`${waitOptions.message ?? 'at capacity'} (waited ${waitOptions.timeoutMs}ms for a slot)`));
					}, waitOptions.timeoutMs);

				waiter.admit = () => {
					// Claim before resolving, and before `done` clears the timer:
					// `pump` probes capacity again on its next iteration and must
					// see this slot as taken.
					claim();
					done(resolve)(undefined);
				};

				if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
				line.push(waiter);
				lines.set(key, line);
			});
		},

		/** Give freed slots to whoever is waiting. Safe to call when nobody is. */
		release(key) { pump(key); },

		/** Re-pump every line; call when the limits themselves change. */
		refresh() { for (const key of [...lines.keys()]) pump(key); },

		/** How many are waiting on a key — the stats route reports it. */
		waiting(key) { return lines.get(key)?.length ?? 0; },

		/** Every key with a non-empty line. */
		keys() { return [...lines.keys()]; },
	};
}
