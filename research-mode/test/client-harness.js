/**
 * Driving the browser half without a browser.
 *
 * The width pill's interesting behaviour is all in its hooks — a load that
 * retries, a debounce that must survive unmount, a transport that must not fail
 * silently — and none of that is reachable from the accessibility tree. A real
 * browser can render the control and prove a write lands; it cannot force a
 * React unmount mid-debounce, which is precisely the case that used to drop the
 * user's last keystroke.
 *
 * So: a hook-faithful React stub (state, effects with dependency comparison and
 * ordered cleanup, refs, memoised callbacks), a controllable clock, and a
 * scripted `fetch`. The bundle is evaluated the way the loader evaluates it —
 * `window.__ModuleLoader__.load({ id, factory })` — so the module's own
 * registration path is exercised too, not bypassed.
 *
 * @module @creait/dsh-research-mode/test/client-harness
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const BUNDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'client.cjs');

/** A `setTimeout` whose passage of time the test decides. */
function makeClock() {
	let next = 1;
	const timers = new Map();
	return {
		setTimeout: (fn, delay) => { const id = next++; timers.set(id, { fn, at: delay ?? 0 }); return id; },
		clearTimeout: (id) => { timers.delete(id); },
		/** Fire every timer due within `ms`, in scheduling order. */
		tick(ms) {
			for (const [id, timer] of [...timers.entries()]) {
				if (timer.at > ms) { timer.at -= ms; continue; }
				timers.delete(id);
				timer.fn();
			}
		},
		get pending() { return timers.size; },
	};
}

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((dep, i) => Object.is(dep, b[i]));

/**
 * A React stub with real hook semantics.
 *
 * Only the parts the control uses, but those parts behave: dependency arrays
 * gate effects and callbacks, cleanups run before a re-run and in declaration
 * order on unmount (which is what lets the flush effect see a live `alive` ref
 * being cleared by an earlier cleanup), and a setState from an async callback
 * re-renders.
 */
function makeReact() {
	let hooks = [];
	let cursor = 0;
	let rendering = false;
	let dirty = false;
	let current = null;

	const React = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat().filter((c) => c !== null && c !== undefined) }),
		useState(initial) {
			const slot = cursor++;
			if (!(slot in hooks)) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial };
			const cell = hooks[slot];
			return [cell.value, (next) => {
				const value = typeof next === 'function' ? next(cell.value) : next;
				if (Object.is(value, cell.value)) return;
				cell.value = value;
				if (rendering) { dirty = true; return; }
				current?.flushRender();
			}];
		},
		useRef(initial) {
			const slot = cursor++;
			if (!(slot in hooks)) hooks[slot] = { current: initial };
			return hooks[slot];
		},
		useCallback(fn, deps) {
			const slot = cursor++;
			const cell = hooks[slot];
			if (cell !== undefined && sameDeps(cell.deps, deps)) return cell.fn;
			hooks[slot] = { fn, deps };
			return fn;
		},
		useEffect(fn, deps) {
			const slot = cursor++;
			const cell = hooks[slot];
			// Queued, not run: effects fire after the render commits, so a
			// setState inside one re-renders rather than recursing.
			current.queue.push({ slot, fn, deps, previous: cell });
		},
	};

	return {
		React,
		mount(Component, props) {
			hooks = [];
			cursor = 0;
			const instance = {
				props,
				output: null,
				queue: [],
				flushRender() {
					let guard = 0;
					do {
						dirty = false;
						cursor = 0;
						instance.queue = [];
						rendering = true;
						try { instance.output = Component(instance.props); } finally { rendering = false; }
						for (const effect of instance.queue) {
							if (effect.previous !== undefined && sameDeps(effect.previous.deps, effect.deps)) { hooks[effect.slot] = effect.previous; continue; }
							effect.previous?.cleanup?.();
							hooks[effect.slot] = { deps: effect.deps, cleanup: effect.fn() ?? undefined };
						}
						if (++guard > 50) throw new Error('render loop did not settle');
					} while (dirty);
				},
				setProps(next) { instance.props = { ...instance.props, ...next }; instance.flushRender(); },
				unmount() {
					// Declaration order, as React does it: the flush effect's
					// cleanup must see what earlier cleanups already did.
					for (const cell of hooks) cell?.cleanup?.();
				},
			};
			current = instance;
			instance.flushRender();
			return instance;
		},
	};
}

/**
 * Load the bundle and hand back its slot component plus the test's controls.
 *
 * @param options - `{ responses }`, a list of scripted answers consumed in
 *   request order. Each is `{ status, body }`, or a function of the request, or
 *   `'network'` for a rejected fetch. A missing entry answers 200 with `body`
 *   omitted, which is the "no more requests expected" tripwire.
 * @returns `{ Component, mount, clock, requests, warnings, id }`.
 */
export function loadClient(options = {}) {
	const responses = [...(options.responses ?? [])];
	const requests = [];
	const warnings = [];
	const clock = makeClock();
	const { React, mount } = makeReact();

	const fetch = (url, init) => {
		const request = { url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(init.body) };
		requests.push(request);
		const scripted = responses.shift();
		const answer = typeof scripted === 'function' ? scripted(request) : scripted;
		if (answer === 'network') return Promise.reject(new Error('offline'));
		const status = answer?.status ?? 200;
		return Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			json: () => (answer && 'body' in answer ? Promise.resolve(answer.body) : Promise.reject(new Error('no body'))),
		});
	};

	let registered = null;
	let component = null;
	const sandbox = {
		window: { __ModuleLoader__: { load: (module) => { registered = module; } } },
		console: { warn: (...args) => warnings.push(args.join(' ')), error: (...args) => warnings.push(args.join(' ')) },
		fetch,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		URL,
		JSON,
		Number,
		Math,
		Array,
		Object,
		Promise,
		Error,
		String,
		Boolean,
		Symbol,
	};
	vm.runInNewContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { filename: 'client.cjs' });

	const exported = registered.factory((name) => {
		if (name === 'react') return React;
		throw new Error(`unexpected require: ${name}`);
	});

	// Through `apply`, so the slot registration itself is under test: the
	// component the harness drives is the one the harness would have mounted.
	const locales = [];
	exported.apply({
		effect: (fn) => fn(),
		locale: { register: (ns, bundles) => { locales.push({ ns, bundles }); } },
		slots: {
			inject: (_name, fn) => fn(),
			register: (descriptor, Component) => { component = Component; return () => {}; },
		},
	});

	return { id: registered.id, inject: exported.inject, Component: component, locales, mount, clock, requests, warnings, React };
}

/** Props for a session on the research preset (or, with `preset`, one that is not). */
export function propsFor(overrides = {}) {
	const preset = 'preset' in overrides ? overrides.preset : 'research';
	return {
		sessionId: 's1',
		t: (key) => key,
		useSessions: (selector) => selector({ byId: { s1: { agentPreset: preset } } }),
		...overrides,
	};
}
