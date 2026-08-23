/**
 * The loopback surface.
 *
 * These routes are the only way the table is read or written, so the tests
 * cover the guard that keeps a write off the network, the validation that keeps
 * a half-formed row out of settings.yaml, and the one query the composer pill
 * makes on every model change.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { THINK_LEVEL_SETTINGS_NAMESPACE } from '../lib/config.js';
import { DEFAULT_EFFORTS, PI_AI_SETTINGS_NAMESPACE } from '../lib/pi-ai-levels.js';
import {
	CATALOG_ROUTE,
	CONFIG_ROUTE,
	EFFORTS_ROUTE,
	LEVELS_ROUTE,
	isLoopbackRequest,
	makeSettingsRoutes,
	validateDefaults,
} from '../lib/settings-routes.js';

const LEVELS = [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }];

function makeRequest(overrides = {}) {
	const body = overrides.body;
	const request = {
		method: 'GET',
		url: CONFIG_ROUTE,
		socket: { remoteAddress: '127.0.0.1' },
		...overrides,
		headers: { host: '127.0.0.1:3080', ...overrides.headers },
	};
	if (body !== undefined) {
		request[Symbol.asyncIterator] = async function* iterate() {
			yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
		};
	}
	return request;
}

function makeResponse() {
	const captured = {};
	return {
		captured,
		writeHead(status) { captured.status = status; },
		end(payload) { captured.body = JSON.parse(payload); },
	};
}

/** The settings provider's own op walker, small enough to restate honestly. */
function applyOp(section, op) {
	const next = structuredClone(section);
	let node = next;
	for (const part of op.path.slice(0, -1)) {
		if (node[part] === null || typeof node[part] !== 'object' || Array.isArray(node[part])) node[part] = {};
		node = node[part];
	}
	const leaf = op.path[op.path.length - 1];
	if (op.op === 'unset') delete node[leaf];
	else node[leaf] = op.value;
	return next;
}

/** The levels a declared map publishes, the way pi-ai materializes them. */
function publishedBy(efforts) {
	if (efforts === undefined || efforts === false) return undefined;
	const ids = Object.keys(efforts).filter((level) => efforts[level] !== null || level === 'off');
	return { efforts: ids.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })), defaultEffort: undefined };
}

/**
 * Mount the routes over a stub settings service.
 * @param options - `defaults` seed, `writable`, `piAi` section, and whether
 *   pi-ai's validator refuses the write.
 * @returns the route family plus the stub's state.
 */
function mount(options = {}) {
	const state = {
		defaults: options.defaults ?? [], revision: 1, updates: [],
		piAi: options.piAi, piRevision: 7, mutations: [],
	};
	const settings = {
		writable: options.writable ?? true,
		describe: () => [
			{
				ns: THINK_LEVEL_SETTINGS_NAMESPACE,
				value: { defaults: state.defaults },
				user: { defaults: state.defaults },
				revision: state.revision,
			},
			...(state.piAi === undefined ? [] : [{
				ns: PI_AI_SETTINGS_NAMESPACE,
				value: state.piAi,
				user: state.piAi,
				revision: state.piRevision,
			}]),
		],
		update: async (ns, patch, revision) => {
			state.updates.push({ ns: String(ns), patch, revision });
			state.defaults = patch.defaults;
			state.revision += 1;
		},
		mutate: async (ns, ops, revision) => {
			state.mutations.push({ ns: String(ns), ops, revision });
			// pi-ai validates its own namespace on write, so a map it cannot
			// serve throws HERE, naming the route and model.
			if (options.refuse) throw new Error('llm-pi-ai: provider "dgx" model "v4" reasoningEfforts offers no level beyond "off"');
			for (const op of ops) state.piAi = applyOp(state.piAi, op);
			state.piRevision += 1;
		},
	};
	const ctx = { get: (name) => (name === 'settings' ? (options.noSettings ? undefined : settings) : undefined) };
	const llm = {
		listProviders: async () => [{ id: 'dgx', name: 'DGX' }],
		listModels: async () => [{ id: 'v4', name: 'V4' }],
	};
	// Reads the declaration back, so a test can see the levels a write just
	// created rather than a fixture asserting that it would have.
	const reasoningOf = async (provider, model) => {
		const entry = state.piAi?.providers?.[provider]?.models?.find((candidate) => candidate.id === model);
		if (entry !== undefined) return publishedBy(entry.reasoningEfforts);
		const override = state.piAi?.providers?.[provider]?.modelOverrides?.[model];
		if (override !== undefined) return publishedBy(override.reasoningEfforts);
		if (state.piAi !== undefined) return undefined;
		return model === 'plain' ? undefined : { efforts: LEVELS, defaultEffort: 'high' };
	};
	const routes = makeSettingsRoutes(ctx, options.noLlm ? undefined : llm, reasoningOf, () => { state.invalidated = true; });
	const call = async (path, request) => {
		const route = routes.find((candidate) => candidate.path === path);
		const res = makeResponse();
		await route.handler(makeRequest({ url: path, ...request }), res);
		return res.captured;
	};
	return { state, call };
}

describe('isLoopbackRequest', () => {
	it('admits this machine talking to itself', () => {
		assert.equal(isLoopbackRequest(makeRequest()), true);
		assert.equal(isLoopbackRequest(makeRequest({ headers: { host: 'localhost:3080', origin: 'http://localhost:3080' } })), true);
	});

	it('refuses anything arriving over the network', () => {
		assert.equal(isLoopbackRequest(makeRequest({ socket: { remoteAddress: '192.168.1.9' } })), false);
		assert.equal(isLoopbackRequest(makeRequest({ headers: { host: 'dsh.example.com' } })), false);
	});

	it('refuses a cross-site request even from this machine', () => {
		// A page on another origin can still reach 127.0.0.1 from this browser;
		// this is the header that says it did.
		assert.equal(isLoopbackRequest(makeRequest({ headers: { 'sec-fetch-site': 'cross-site' } })), false);
		assert.equal(isLoopbackRequest(makeRequest({ headers: { origin: 'https://evil.example' } })), false);
	});
});

describe('validateDefaults', () => {
	it('accepts a complete table', () => {
		const checked = validateDefaults([{ provider: 'dgx', model: 'v4', effort: 'high' }]);
		assert.deepEqual(checked, { ok: true, defaults: [{ provider: 'dgx', model: 'v4', effort: 'high' }] });
	});

	it('rejects a half-formed row rather than dropping it', () => {
		// Reading one out of a hand-edited settings.yaml is something to
		// survive; being POSTed one is a bug in the caller, and a 200 would
		// report a row stored that never matches anything.
		for (const rows of [[{ provider: 'dgx', model: '', effort: 'high' }], [{ provider: 'dgx', model: 'v4' }], [null], 'nope']) {
			assert.equal(validateDefaults(rows).ok, false);
		}
	});
});

describe('routes', () => {
	it('answers a non-loopback request with 403 and no settings at all', async () => {
		const { call } = mount({ defaults: [{ provider: 'dgx', model: 'v4', effort: 'high' }] });
		for (const path of [CONFIG_ROUTE, CATALOG_ROUTE, EFFORTS_ROUTE]) {
			const answer = await call(path, { socket: { remoteAddress: '10.0.0.4' } });
			assert.equal(answer.status, 403);
			assert.equal(answer.body.value, undefined);
		}
	});

	it('reads the table back with its revision', async () => {
		const { call } = mount({ defaults: [{ provider: 'dgx', model: 'v4', effort: 'high' }] });
		const answer = await call(CONFIG_ROUTE);
		assert.equal(answer.status, 200);
		assert.equal(answer.body.status, 'ready');
		assert.deepEqual(answer.body.value.defaults, [{ provider: 'dgx', model: 'v4', effort: 'high' }]);
		assert.equal(answer.body.writable, true);
		assert.equal(answer.body.revision, 1);
	});

	it('replaces the table against the revision it read', async () => {
		const { call, state } = mount({ defaults: [{ provider: 'dgx', model: 'v4', effort: 'high' }] });
		const answer = await call(CONFIG_ROUTE, { method: 'POST', body: { defaults: [{ provider: 'dgx', model: 'v4', effort: 'off' }] } });
		assert.equal(answer.status, 200);
		assert.deepEqual(state.updates[0].patch.defaults, [{ provider: 'dgx', model: 'v4', effort: 'off' }]);
		assert.equal(state.updates[0].revision, 1);
		assert.deepEqual(answer.body.value.defaults, [{ provider: 'dgx', model: 'v4', effort: 'off' }]);
	});

	it('writes nothing when the posted table is the one already stored', async () => {
		const rows = [{ provider: 'dgx', model: 'v4', effort: 'high' }];
		const { call, state } = mount({ defaults: rows });
		await call(CONFIG_ROUTE, { method: 'POST', body: { defaults: rows } });
		assert.deepEqual(state.updates, [], 'a no-op edit does not burn a revision');
	});

	it('refuses a payload that names nothing, and a body that is not JSON', async () => {
		const { call, state } = mount();
		assert.equal((await call(CONFIG_ROUTE, { method: 'POST', body: { limits: [] } })).status, 400);
		assert.equal((await call(CONFIG_ROUTE, { method: 'POST', body: 'not json' })).status, 400);
		assert.equal((await call(CONFIG_ROUTE, { method: 'POST', body: { defaults: [{ provider: 'dgx' }] } })).status, 400);
		assert.equal((await call(CONFIG_ROUTE, { method: 'DELETE' })).status, 405);
		assert.deepEqual(state.updates, []);
	});

	it('reports the levels of one model, asked for by query', async () => {
		const { call } = mount();
		const answer = await call(EFFORTS_ROUTE, { url: `${EFFORTS_ROUTE}?provider=dgx&model=v4` });
		assert.equal(answer.status, 200);
		assert.deepEqual(answer.body, { efforts: LEVELS, defaultEffort: 'high' });
	});

	it('reports a model that cannot think as an empty list, not an error', async () => {
		// "This model has no levels" is an answer the card renders; a 404 would
		// only look like the route was broken.
		const { call } = mount();
		const answer = await call(EFFORTS_ROUTE, { url: `${EFFORTS_ROUTE}?provider=dgx&model=plain` });
		assert.equal(answer.status, 200);
		assert.deepEqual(answer.body, { efforts: [] });
	});

	it('refuses an efforts query that names no model', async () => {
		const { call } = mount();
		assert.equal((await call(EFFORTS_ROUTE, { url: `${EFFORTS_ROUTE}?provider=dgx` })).status, 400);
	});

	it('serves an empty catalog rather than failing without an llm service', async () => {
		const { call } = mount({ noLlm: true });
		const answer = await call(CATALOG_ROUTE);
		assert.equal(answer.status, 200);
		assert.deepEqual(answer.body, { providers: [], models: {} });
	});

	it('reports a read-only deployment instead of pretending to write', async () => {
		const { call } = mount({ noSettings: true });
		assert.equal((await call(CONFIG_ROUTE)).body.writable, false);
		assert.equal((await call(CONFIG_ROUTE, { method: 'POST', body: { defaults: [] } })).status, 503);
	});
});

describe('levels', () => {
	/** A route that spells its models out — the case with no levels to offer. */
	const DGX = { providers: { dgx: { api: 'openai-completions', models: [{ id: 'v4', name: 'V4' }] } } };
	const query = '?provider=dgx&model=v4';

	it('reports what the model publishes and where it could be declared', async () => {
		const { call } = mount({ piAi: DGX });
		const answer = await call(LEVELS_ROUTE, { url: LEVELS_ROUTE + query });
		assert.equal(answer.status, 200);
		assert.deepEqual(answer.body.supported, []);
		assert.equal(answer.body.shape, 'models');
		assert.equal(answer.body.declared, null);
		assert.equal(answer.body.writable, true);
		// The pill posts this back verbatim, so it has to arrive with the view.
		assert.deepEqual(answer.body.suggested, DEFAULT_EFFORTS);
	});

	it('says plainly when a model is not pi-ai\'s to declare', async () => {
		const { call } = mount({ piAi: DGX });
		const answer = await call(LEVELS_ROUTE, { url: LEVELS_ROUTE + '?provider=deepseek-official&model=v4-pro' });
		assert.equal(answer.body.shape, null);
		assert.equal(answer.body.reason, 'no-route');
		// Not writable, so the pill offers nothing rather than offering a
		// button that would 400.
		assert.equal(answer.body.writable, false);
	});

	it('declares the levels, and answers with the ones that now exist', async () => {
		const { call, state } = mount({ piAi: DGX });
		const answer = await call(LEVELS_ROUTE, {
			url: LEVELS_ROUTE + query, method: 'POST', body: { efforts: DEFAULT_EFFORTS },
		});
		assert.equal(answer.status, 200);
		assert.deepEqual(state.mutations, [{
			ns: PI_AI_SETTINGS_NAMESPACE,
			ops: [{ op: 'set', path: ['providers', 'dgx', 'models'], value: [{ id: 'v4', name: 'V4', reasoningEfforts: DEFAULT_EFFORTS }] }],
			revision: 7,
		}]);
		// The write changed what the model publishes, so the cached answer from
		// a moment ago has to be dropped before this response is built.
		assert.equal(state.invalidated, true);
		assert.deepEqual(answer.body.supported.map((level) => level.id), ['off', 'low', 'medium', 'high', 'max']);
		assert.deepEqual(answer.body.declared, DEFAULT_EFFORTS);
	});

	it('withdraws a declaration and reports the model back to silent', async () => {
		const declared = { providers: { dgx: { models: [{ id: 'v4', reasoningEfforts: DEFAULT_EFFORTS }] } } };
		const { call, state } = mount({ piAi: declared });
		const answer = await call(LEVELS_ROUTE, { url: LEVELS_ROUTE + query, method: 'POST', body: { efforts: null } });
		assert.equal(answer.status, 200);
		assert.deepEqual(state.piAi.providers.dgx.models, [{ id: 'v4' }]);
		assert.deepEqual(answer.body.supported, []);
	});

	it('names the level it refuses, and writes nothing', async () => {
		const { call, state } = mount({ piAi: DGX });
		const answer = await call(LEVELS_ROUTE, {
			url: LEVELS_ROUTE + query, method: 'POST', body: { efforts: { sideways: 'hard' } },
		});
		assert.equal(answer.status, 400);
		assert.match(answer.body.error, /sideways/);
		assert.deepEqual(state.mutations, []);
	});

	it('passes pi-ai\'s own refusal through instead of inventing one', async () => {
		// This is the whole reason the write goes through the settings service
		// rather than the file: the namespace's validator runs on the write and
		// says which route and model it could not serve.
		const { call } = mount({ piAi: DGX, refuse: true });
		const answer = await call(LEVELS_ROUTE, {
			url: LEVELS_ROUTE + query, method: 'POST', body: { efforts: DEFAULT_EFFORTS },
		});
		assert.equal(answer.status, 409);
		assert.match(answer.body.error, /llm-pi-ai: provider "dgx"/);
	});

	it('refuses a query that names no model, and a body that declares nothing', async () => {
		const { call } = mount({ piAi: DGX });
		assert.equal((await call(LEVELS_ROUTE, { url: LEVELS_ROUTE + '?provider=dgx' })).status, 400);
		assert.equal((await call(LEVELS_ROUTE, { url: LEVELS_ROUTE + query, method: 'POST', body: {} })).status, 400);
		assert.equal((await call(LEVELS_ROUTE, { url: LEVELS_ROUTE + query, method: 'DELETE' })).status, 405);
	});
});
