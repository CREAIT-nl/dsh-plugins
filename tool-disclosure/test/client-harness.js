/**
 * Driving the browser half without a browser.
 *
 * The settings page's interesting behaviour is in its hooks: a switch that
 * moves before the server has answered, a write that rebuilds the whole
 * `defer` list from what is on screen, and a re-measure that must follow every write —
 * including a failed one. A real browser proves the page renders and that a
 * write lands (both verified there); it cannot force a write to fail, and it
 * cannot show that the numbers came back from the host rather than from the
 * optimistic flip.
 *
 * So: a hook-faithful React stub, a `fetch` that answers by route, and the
 * bundle evaluated the way the loader evaluates it —
 * `window.__ModuleLoader__.load({ id, factory })` — so the module's own
 * registration path is exercised rather than bypassed.
 *
 * @module @creait/dsh-tool-disclosure/test/client-harness
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const BUNDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'client.cjs');

export const CONFIG_ROUTE = '/api/dsh-tool-disclosure/config';
export const GROUPS_ROUTE = '/api/dsh-tool-disclosure/groups';

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((dep, i) => Object.is(dep, b[i]));

/**
 * A React stub with real hook semantics.
 *
 * Only the parts the page uses, but those parts behave: dependency arrays gate
 * effects and callbacks, cleanups run before a re-run and in declaration order
 * on unmount (which is what lets the `alive` ref suppress a response arriving
 * after the panel closed), and a setState from an async callback re-renders.
 */
function makeReact() {
	let hooks = [];
	let cursor = 0;
	let rendering = false;
	let dirty = false;
	let current = null;

	const React = {
		Fragment: Symbol('Fragment'),
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
 * A stub of the primitives seed module, shaped like the part the bundle uses.
 *
 * Not the harness's real component — the browser check covers that. What it
 * covers is that the primitives *branch executes at all*: with the seed absent
 * `Pill` falls back to the plain span this file used to render, so without a
 * stub every test would measure the fallback and the path that actually ships
 * in a browser would never run.
 */
function makePrimitives(React) {
	return { Pill: (props) => React.createElement('span', { 'data-primitive': 'Pill', className: props.className }, props.children) };
}

/**
 * Load the bundle and hand back its section component plus the test's controls.
 *
 * @param options - `groups` and `config` are the two GET payloads, each either
 *   a value or a thunk (a thunk is how a test makes the re-measure differ from
 *   the first read); `post` answers the write, defaulting to accepting it;
 *   either may be `'network'` for a rejected fetch. `primitives: true` serves
 *   the seed-module stub, which is what every browser resolves.
 * @returns `{ Component, mount, requests, warnings, locales, inject, id }`.
 */
export function loadClient(options = {}) {
	const requests = [];
	const warnings = [];
	const { React, mount } = makeReact();
	const primitives = options.primitives ? makePrimitives(React) : null;

	const answerFor = (request) => {
		if (request.method === 'POST') return options.post ?? { body: { writable: true } };
		if (request.url === GROUPS_ROUTE) return typeof options.groups === 'function' ? options.groups() : options.groups;
		if (request.url === CONFIG_ROUTE) return typeof options.config === 'function' ? options.config() : options.config;
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
		// No `document` and no `MutationObserver`: this is the headless case the
		// CSS injection and the nav-icon repaint both guard against, so their
		// guards are under test here too.
		window: { __ModuleLoader__: { load: (module) => { registered = module; } } },
		console: { warn: (...args) => warnings.push(args.join(' ')), error: (...args) => warnings.push(args.join(' ')) },
		fetch,
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
		if (name === '@deepseek-ai/dsh-client-ui-primitives') {
			if (primitives === null) throw new Error('seed module absent');
			return primitives;
		}
		throw new Error(`unexpected require: ${name}`);
	});

	// Through `apply`, so the slot registration itself is under test: the
	// component the harness drives is the one the shell would have mounted.
	const locales = [];
	exported.apply({
		effect: (fn) => fn(),
		locale: {
			register: (ns, bundles) => { locales.push({ ns, bundles }); },
			bind: () => (key) => key,
		},
		slots: {
			inject: (_name, fn) => fn(),
			register: (given, Component) => { descriptor = given; component = Component; return () => {}; },
		},
	});

	return { id: registered.id, inject: exported.inject, Component: component, descriptor, locales, mount, requests, warnings, primitives, React };
}

/** Every element in a rendered tree, depth first. */
export function walk(node, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out;
	out.push(node);
	for (const child of node.children ?? []) walk(child, out);
	return out;
}

/** The `GroupRow` elements the page rendered, in order. */
export function rowsOf(instance) {
	return walk(instance.output).filter((node) => typeof node.type === 'function' && node.props.group !== undefined);
}

/** Render one row's own output, which is where its switch lives. */
export function renderRow(row) {
	return row.type(row.props);
}

/** The `Switch` element inside a rendered row. */
export function switchOf(row) {
	const rendered = renderRow(row);
	const node = walk(rendered).find((entry) => typeof entry.type === 'function' && entry.props.checked !== undefined);
	// One more level: `Switch` renders the button carrying the ARIA state.
	return node === undefined ? undefined : node.type(node.props);
}

/** The three headline figures, as `{ label: value }`. */
export function statsOf(instance) {
	const stats = {};
	for (const node of walk(instance.output)) {
		if (typeof node.type !== 'function' || node.props.value === undefined || node.props.label === undefined) continue;
		stats[node.props.label] = node.props.value;
	}
	return stats;
}

/** Text of every node carrying `className`, joined. */
export function textOf(instance, className) {
	return walk(instance.output)
		.filter((node) => node.props?.className === className)
		.map((node) => node.children.filter((child) => typeof child === 'string').join(''))
		.join(' | ');
}

/** Props a mounted section receives from the shell. */
export function propsFor(overrides = {}) {
	return { t: (key) => key, close: () => {}, ...overrides };
}

/** Let every queued microtask settle, which is where the fetch chains live. */
export const settle = () => new Promise((resolve) => { setImmediate(resolve); });
