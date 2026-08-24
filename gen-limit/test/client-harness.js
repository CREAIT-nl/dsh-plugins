/**
 * Driving the browser half without a browser.
 *
 * The settings page's interesting behaviour is not what it renders — a real
 * browser proves that, and did — it is what it *writes*, and when. The queue
 * fields debounce, so the thing under test is a timer: that an empty box is not
 * the number zero, that closing the panel mid-debounce flushes the edit rather
 * than dropping it, and that the write which lands carries no `limits` array so
 * a limits edit made elsewhere is not clobbered by whatever this page happened
 * to be holding. None of that is observable by looking at a page.
 *
 * So: a hook-faithful React stub, a controllable clock, a `fetch` that answers
 * by route, and the bundle evaluated the way the loader evaluates it —
 * `window.__ModuleLoader__.load({ id, factory })` — so the module's own
 * registration path is exercised rather than bypassed.
 *
 * Two axes the shell varies and the tests therefore vary too. `primitives:
 * true` serves a stub for `@deepseek-ai/dsh-client-ui-primitives`, because in
 * the browser that seed module always resolves: without it every test would
 * exercise the fallback markup and the path that actually ships would never
 * run. `document: true` supplies a DOM stub for the nav-icon repaint; the
 * default is headless, which is the case the CSS injection and the observer
 * both guard against.
 *
 * @module @creait/dsh-gen-limit/test/client-harness
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const BUNDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'client.cjs');

export const CONFIG_ROUTE = '/api/dsh-gen-limit/config';
export const CATALOG_ROUTE = '/api/dsh-gen-limit/catalog';
export const STATS_ROUTE = '/api/dsh-gen-limit/stats';

/** The debounce the queue fields run on, mirrored from the bundle. */
export const WRITE_DELAY_MS = 600;

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((dep, i) => Object.is(dep, b[i]));

/**
 * A React stub with real hook semantics.
 *
 * Only the parts the page uses, but those parts behave: dependency arrays gate
 * effects and callbacks, cleanups run before a re-run and on unmount (which is
 * what lets the unmount effect flush the debounce and the `alive` ref suppress
 * a response arriving after the panel closed), and a setState from an async
 * callback re-renders.
 */
function makeReact() {
	// Hook storage belongs to the mounted instance, not to the module: the
	// tests mount a child (a `Selector`, to open its menu) while its parent is
	// still mounted, and a single shared array would hand the child the
	// parent's slots — which reads as an effect re-firing forever.
	let current = null;

	const React = {
		Fragment: Symbol('Fragment'),
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat().filter((c) => c !== null && c !== undefined) }),
		useState(initial) {
			const owner = current;
			const slot = owner.cursor++;
			if (!(slot in owner.hooks)) owner.hooks[slot] = { value: typeof initial === 'function' ? initial() : initial };
			const cell = owner.hooks[slot];
			return [cell.value, (next) => {
				const value = typeof next === 'function' ? next(cell.value) : next;
				if (Object.is(value, cell.value)) return;
				cell.value = value;
				// Batched, not re-entrant. React does not re-render in the
				// middle of the effect pass; doing so here would let an effect
				// see its own hook slot before the pass had recorded it, and
				// the effect would re-run forever. `dirty` makes the loop go
				// round once more instead.
				if (owner.rendering || owner.flushing) { owner.dirty = true; return; }
				owner.flushRender();
			}];
		},
		useRef(initial) {
			const owner = current;
			const slot = owner.cursor++;
			if (!(slot in owner.hooks)) owner.hooks[slot] = { current: initial };
			return owner.hooks[slot];
		},
		useCallback(fn, deps) {
			const owner = current;
			const slot = owner.cursor++;
			const cell = owner.hooks[slot];
			if (cell !== undefined && sameDeps(cell.deps, deps)) return cell.fn;
			owner.hooks[slot] = { fn, deps };
			return fn;
		},
		useEffect(fn, deps) {
			const owner = current;
			const slot = owner.cursor++;
			const cell = owner.hooks[slot];
			// Queued, not run: effects fire after the render commits, so a
			// setState inside one re-renders rather than recursing.
			owner.queue.push({ slot, fn, deps, previous: cell });
		},
	};

	return {
		React,
		mount(Component, props) {
			const instance = {
				props,
				output: null,
				queue: [],
				hooks: [],
				cursor: 0,
				rendering: false,
				flushing: false,
				dirty: false,
				flushRender() {
					const outer = current;
					current = instance;
					try {
						let guard = 0;
						do {
							instance.dirty = false;
							instance.cursor = 0;
							instance.queue = [];
							instance.rendering = true;
							try { instance.output = Component(instance.props); } finally { instance.rendering = false; }
							instance.flushing = true;
							try {
								for (const effect of instance.queue) {
									if (effect.previous !== undefined && sameDeps(effect.previous.deps, effect.deps)) { instance.hooks[effect.slot] = effect.previous; continue; }
									effect.previous?.cleanup?.();
									instance.hooks[effect.slot] = { deps: effect.deps, cleanup: effect.fn() ?? undefined };
								}
							} finally { instance.flushing = false; }
							if (++guard > 50) throw new Error('render loop did not settle');
						} while (instance.dirty);
					} finally { current = outer; }
				},
				setProps(next) { instance.props = { ...instance.props, ...next }; instance.flushRender(); },
				unmount() {
					for (const cell of instance.hooks) cell?.cleanup?.();
				},
			};
			instance.flushRender();
			return instance;
		},
	};
}

/**
 * A clock the test advances by hand.
 *
 * The page debounces writes and polls stats on an interval, so the tests need
 * to say "600ms passed" without waiting 600ms — and, more importantly, need to
 * be able to *not* say it, which is how "the write has not gone out yet" is
 * asserted at all.
 */
function makeClock() {
	let now = 0;
	let nextId = 1;
	const timers = new Map();
	return {
		setTimeout: (fn, delay) => { const id = nextId++; timers.set(id, { fn, at: now + (delay ?? 0), every: null }); return id; },
		clearTimeout: (id) => { timers.delete(id); },
		setInterval: (fn, every) => { const id = nextId++; timers.set(id, { fn, at: now + (every ?? 0), every: every ?? 0 }); return id; },
		clearInterval: (id) => { timers.delete(id); },
		/** Move the clock forward, firing whatever comes due, in due order. */
		advance(ms) {
			const until = now + ms;
			for (;;) {
				let due = null;
				for (const [id, timer] of timers) if (timer.at <= until && (due === null || timer.at < due[1].at)) due = [id, timer];
				if (due === null) break;
				const [id, timer] = due;
				now = timer.at;
				if (timer.every === null) timers.delete(id);
				else timer.at = now + timer.every;
				timer.fn();
			}
			now = until;
		},
		/** How many timers are still armed — an interval left running is a leak. */
		get armed() { return timers.size; },
	};
}

/**
 * A stub of the primitives seed module, shaped like the parts the bundle uses.
 *
 * These are not the harness's real components and cannot prove the props match
 * what the real ones accept — the browser check does that. What they prove is
 * that the primitives *branch executes*: with the seed absent every wrapper in
 * the bundle takes its fallback arm, so `Selector`'s Menu path, `Btn`'s
 * variant/size mapping and `Count`'s Pill would otherwise never run in a test
 * at all. Each stub keeps the props it was handed so a test can read them.
 */
function makePrimitives(React) {
	const h = React.createElement;
	const Button = (props) => h('button', { 'data-primitive': 'Button', ...props }, props.children);
	const Input = (props) => h('input', { 'data-primitive': 'Input', ...props });
	const Pill = (props) => h('span', { 'data-primitive': 'Pill' }, props.children);
	const Menu = (props) => h('div', { 'data-primitive': 'Menu', menu: props }, props.anchor);
	const IconChevronDownOutline14 = (props) => h('svg', { 'data-primitive': 'Chevron', ...props });
	return { Button, Input, Pill, Menu, IconChevronDownOutline14 };
}

/**
 * The smallest DOM that `paintNavIcon` can be asked a real question about.
 *
 * Nodes carry only what the repaint touches: `textContent` to match the row by
 * its label in either locale, `dataset` for the already-painted flag, `querySelector`
 * down to the svg and its first path, and `querySelectorAll('path')` so the
 * surplus-path removal has something to remove.
 */
export function makeDom(cells = []) {
	const head = { children: [], appendChild(node) { head.children.push(node); } };
	const styles = [];
	const body = {};
	let observer = null;
	const document = {
		head,
		body,
		createElement: () => ({ dataset: {}, textContent: '' }),
		querySelector: (selector) => (selector.startsWith('style[') ? (styles.length ? styles[0] : null) : null),
		querySelectorAll: (selector) => (selector.includes('nav button') ? cells : []),
	};
	// The bundle injects its stylesheet at load; record it so the test can see
	// it landed exactly once.
	const originalAppend = head.appendChild;
	head.appendChild = (node) => { styles.push(node); originalAppend(node); };
	return {
		document,
		styles,
		cells,
		MutationObserver: class {
			constructor(fn) { observer = { fn, options: null }; }
			observe(target, options) { observer.options = options; observer.target = target; }
		},
		/** Fire the observer as the shell would when it re-renders the panel. */
		mutate() { observer?.fn(); },
		get observer() { return observer; },
	};
}

/** One nav cell: a label, and an svg with `paths` paths under it. */
export function makeNavCell(label, paths = 2) {
	const made = Array.from({ length: paths }, () => ({ attrs: {}, removed: false, setAttribute(k, v) { this.attrs[k] = v; }, remove() { this.removed = true; } }));
	const svg = {
		dataset: {},
		paths: made,
		querySelector: () => made.filter((p) => !p.removed)[0] ?? null,
		querySelectorAll: () => made.filter((p) => !p.removed),
	};
	return { textContent: label, svg, querySelector: (selector) => (selector === 'svg' ? svg : null) };
}

/**
 * Load the bundle and hand back its section component plus the test's controls.
 *
 * @param options - `config`, `catalog` and `stats` are the three GET payloads,
 *   each a value or a thunk (a thunk is how a test makes a later poll differ
 *   from the first read); `post` answers the write, defaulting to echoing the
 *   patch back as a ready view. Any of them may be `'network'` for a rejected
 *   fetch. `primitives: true` serves the seed-module stub; `dom` supplies a
 *   DOM (from `makeDom`) instead of running headless; `locale: 'throws'` makes
 *   `locale.register` throw, which is what a client reload does.
 * @returns the registration, the section component, and the drivers.
 */
export function loadClient(options = {}) {
	const requests = [];
	const warnings = [];
	const { React, mount } = makeReact();
	const clock = makeClock();
	const primitives = options.primitives ? makePrimitives(React) : null;

	const defaultView = { status: 'ready', value: { limits: [] }, writable: true };

	const answerFor = (request) => {
		if (request.method === 'POST') return options.post ?? { body: { ...defaultView, value: { ...defaultView.value, ...request.body } } };
		if (request.url === CONFIG_ROUTE) return typeof options.config === 'function' ? options.config() : (options.config ?? { body: defaultView });
		if (request.url === CATALOG_ROUTE) return typeof options.catalog === 'function' ? options.catalog() : (options.catalog ?? { body: { providers: [], models: {} } });
		if (request.url === STATS_ROUTE) return typeof options.stats === 'function' ? options.stats() : (options.stats ?? { body: { entries: [] } });
		throw new Error(`unexpected request: ${request.url}`);
	};

	const fetch = (url, init) => {
		const request = { url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(init.body) };
		requests.push(request);
		const scripted = answerFor(request);
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
	let descriptor = null;
	const sandbox = {
		window: { __ModuleLoader__: { load: (module) => { registered = module; } } },
		console: { warn: (...args) => warnings.push(args.join(' ')), error: (...args) => warnings.push(args.join(' ')) },
		fetch,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		setInterval: clock.setInterval,
		clearInterval: clock.clearInterval,
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
	if (options.dom) {
		sandbox.document = options.dom.document;
		sandbox.MutationObserver = options.dom.MutationObserver;
		// Synchronous, so `dom.mutate()` repaints before the assertion rather
		// than parking the pass in a frame that never arrives — which would
		// make every "it did not repaint" test pass for the wrong reason.
		sandbox.requestAnimationFrame = (fn) => { fn(); return 0; };
	}
	vm.runInNewContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { filename: 'client.cjs' });

	const exported = registered.factory((name) => {
		if (name === 'react') return React;
		if (name === '@deepseek-ai/dsh-client-ui-primitives') {
			if (primitives === null) throw new Error('seed module absent');
			return primitives;
		}
		throw new Error(`unexpected require: ${name}`);
	});

	// Through `apply`, so the slot registration itself is under test: the
	// component the harness drives is the one the shell would have mounted.
	const locales = [];
	const effects = [];
	exported.apply({
		effect: (fn, label) => { effects.push(label); return fn(); },
		locale: {
			register: (ns, bundles) => {
				if (options.locale === 'throws') throw new Error('already registered');
				locales.push({ ns, bundles });
				return () => {};
			},
			bind: () => (key) => key,
		},
		slots: {
			inject: (_name, fn) => fn(),
			register: (given, Component) => { descriptor = given; component = Component; return () => {}; },
		},
	});

	return { id: registered.id, inject: exported.inject, Component: component, descriptor, locales, effects, mount, requests, warnings, clock, primitives, React };
}

/** Every element in a rendered tree, depth first, following function output. */
export function walk(node, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out;
	out.push(node);
	for (const child of node.children ?? []) walk(child, out);
	return out;
}

/**
 * Render one child element on its own, as its own mount.
 *
 * The wrappers are function components and two of them (`Selector`) use hooks,
 * so they cannot simply be called inline: that would advance the shared hook
 * cursor and corrupt the parent's state. Giving each its own mount is both
 * safe and closer to what React does — and it is what lets a test open a
 * Selector's menu and click an item.
 *
 * @param harness - the object `loadClient` returned.
 * @param element - a node out of the parent's tree.
 * @returns the mounted instance, with `output` and `unmount`.
 */
export function renderChild(harness, element) {
	return harness.mount(element.type, { ...element.props, children: element.children });
}

/** Text of every node carrying `className`, joined. */
export function textOf(instance, className) {
	return walk(instance.output)
		.filter((node) => node.props?.className === className)
		.map((node) => node.children.filter((child) => typeof child === 'string').join(''))
		.join(' | ');
}

/** The `Num` elements the page rendered, in order. */
export function numbersOf(instance) {
	return walk(instance.output).filter((node) => typeof node.type === 'function' && node.props.value !== undefined && node.props.onChange !== undefined && node.props.options === undefined);
}

/** The `Selector` elements the page rendered, in order. */
export function selectorsOf(instance) {
	return walk(instance.output).filter((node) => typeof node.type === 'function' && node.props.options !== undefined);
}

/** The `Btn` elements the page rendered, in order. */
export function buttonsOf(instance) {
	return walk(instance.output).filter((node) => typeof node.type === 'function' && node.props.onClick !== undefined && node.props.options === undefined && node.props.value === undefined);
}

/** Props a mounted section receives from the shell. */
export function propsFor(overrides = {}) {
	return { t: (key) => key, close: () => {}, ...overrides };
}

/** Let every queued microtask settle, which is where the fetch chains live. */
export const settle = () => new Promise((resolve) => { setImmediate(resolve); });
