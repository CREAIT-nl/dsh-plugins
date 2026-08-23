/**
 * The plugin's own loopback HTTP surface: what the Settings page and the
 * composer pill read and write.
 *
 * Why plugin-owned routes instead of the settings RPC: the harness `settings.*`
 * wire only exposes namespaces on a hard-coded allowlist, and a plugin cannot
 * widen it. The namespace IS registered host-side, so this serves its own
 * loopback-only endpoints that read and write it through the settings service —
 * the same shape @creait/dsh-gen-limit uses.
 *
 *   GET  /api/dsh-think-level/config  -> view (value/base/user/writable/revision)
 *   POST /api/dsh-think-level/config  -> { defaults: [...replace-all...] }, returns the new view
 *   GET  /api/dsh-think-level/catalog -> { providers: [{id,name}], models: { [provider]: [{id,name}] } }
 *   GET  /api/dsh-think-level/efforts?provider=&model=
 *                                     -> { efforts: [{id,name}], defaultEffort? }
 *   GET  /api/dsh-think-level/levels?provider=&model=
 *                                     -> what the model publishes AND what
 *                                        `llm-pi-ai` declares for it
 *   POST /api/dsh-think-level/levels?provider=&model=
 *                                     -> { efforts: map | false | null }, declares it
 *
 * The `levels` pair is the one place this plugin writes a namespace it does not
 * own — see ./pi-ai-levels.js for why that is the supported way to give a
 * hand-declared model levels at all, rather than a trick.
 *
 * `efforts` is a separate route from `catalog` on purpose. The effort ids of a
 * model come from `llm.resolveModelInfo`, which is one adapter round-trip PER
 * MODEL; folding them into the catalog would make opening the Settings page
 * resolve every model of every provider to render a list the user is about to
 * narrow to one row. The card asks for the one model it is showing.
 */
import { THINK_LEVEL_SETTINGS_NAMESPACE } from './config.js';
import {
	DEFAULT_EFFORTS,
	NO_ROUTE,
	PI_AI_SETTINGS_NAMESPACE,
	describeDeclaration,
	planDeclaration,
	validateEfforts,
} from './pi-ai-levels.js';

/** The route family. */
export const CONFIG_ROUTE = '/api/dsh-think-level/config';
export const CATALOG_ROUTE = '/api/dsh-think-level/catalog';
export const EFFORTS_ROUTE = '/api/dsh-think-level/efforts';
export const LEVELS_ROUTE = '/api/dsh-think-level/levels';

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 128 * 1024;

/**
 * Whether a request came from this machine's own browser.
 *
 * Exported for the tests: this is the guard that keeps a config write off the
 * network, so it is the one function here worth pinning down.
 * @param request - the incoming request.
 * @returns whether it may read or write settings.
 */
export function isLoopbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
	const host = request.headers.host;
	if (typeof host !== 'string') return false;
	let hostUrl;
	try { hostUrl = new URL(`http://${host}`); } catch { return false; }
	if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false;
	if (request.headers['sec-fetch-site'] === 'cross-site') return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}

function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'referrer-policy': 'no-referrer',
	});
	res.end(payload);
}

async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	let overflow = false;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > MAX_JSON_BODY_BYTES) { overflow = true; continue; }
		chunks.push(buffer);
	}
	if (overflow) return undefined;
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
	} catch { return undefined; }
}

function viewOf(ctx) {
	const settings = ctx.get('settings', false);
	if (settings === undefined) return { status: 'unavailable', writable: false };
	const descriptor = settings
		.describe({ redactSecrets: true })
		.find((candidate) => String(candidate.ns) === THINK_LEVEL_SETTINGS_NAMESPACE);
	if (descriptor === undefined) return { status: 'unavailable', writable: settings.writable };
	return {
		status: 'ready',
		value: descriptor.value,
		...(descriptor.base === undefined ? {} : { base: descriptor.base }),
		...(descriptor.user === undefined ? {} : { user: descriptor.user }),
		writable: settings.writable,
		revision: descriptor.revision,
	};
}

/**
 * Check a posted `defaults` array.
 *
 * Deliberately strict where {@link resolveConfig} is forgiving: reading a
 * half-formed row out of settings.yaml is something to survive, but WRITING one
 * is a bug in the caller, and answering 200 to it would store a table row that
 * silently never matches.
 * @param defaults - the posted array.
 * @returns `{ ok }` with the cleaned rows when every row is complete.
 */
export function validateDefaults(defaults) {
	if (!Array.isArray(defaults)) return { ok: false };
	const out = [];
	for (const entry of defaults) {
		if (typeof entry !== 'object' || entry === null) return { ok: false };
		const provider = String(entry.provider ?? '');
		const model = String(entry.model ?? '');
		const effort = String(entry.effort ?? '');
		if (!provider || !model || !effort) return { ok: false };
		out.push({ provider, model, effort });
	}
	return { ok: true, defaults: out };
}

/**
 * Read pi-ai's namespace, unredacted, in process.
 *
 * `redactSecrets` is for wire surfaces; this one never leaves the host — only
 * the four fields {@link levelsView} names are serialized. Unredacted matters
 * because a `models` list has to be rewritten whole to patch one entry, and
 * rewriting a redacted copy would store the redaction.
 * @param settings - the settings service.
 * @returns the resolved and raw user layers plus the revision, or undefined
 *   when pi-ai is not part of this composition.
 */
function piAiLayers(settings) {
	const descriptor = settings.describe().find((candidate) => String(candidate.ns) === PI_AI_SETTINGS_NAMESPACE);
	if (descriptor === undefined) return undefined;
	return { resolved: descriptor.value, user: descriptor.user, revision: descriptor.revision };
}

/**
 * Everything the pill and the card need to render one model's levels.
 * @param settings - the settings service, or undefined.
 * @param reasoning - what the model publishes today, from the adapter.
 * @param provider - the route key.
 * @param model - the model id.
 * @returns the serializable view.
 */
function levelsView(settings, reasoning, provider, model) {
	const supported = reasoning === undefined ? [] : reasoning.efforts;
	const base = {
		supported,
		...(reasoning?.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort }),
		suggested: DEFAULT_EFFORTS,
	};
	const layers = settings === undefined ? undefined : piAiLayers(settings);
	// No pi-ai, or a route it does not serve: the model still reports what it
	// supports, and `shape: null` says this plugin cannot change that. Another
	// adapter owning its own capability metadata is not an error.
	if (layers === undefined) return { ...base, shape: null, reason: NO_ROUTE, declared: null, writable: false };
	const seen = describeDeclaration(layers.resolved, provider, model);
	return {
		...base,
		shape: seen.shape,
		...(seen.shape === null ? { reason: seen.reason } : {}),
		declared: seen.declared === undefined ? null : seen.declared,
		writable: settings.writable === true && seen.shape !== null,
		revision: layers.revision,
	};
}

/**
 * Build the config/catalog/efforts/levels routes.
 * @param ctx - the host plugin context (read live at request time).
 * @param llm - the live `llm` service, or undefined on a composition without one.
 * @param reasoningOf - cached `(provider, model) -> Promise<{efforts,defaultEffort}|undefined>`,
 *   shared with the request listener so the Settings page and the agent plane
 *   agree about what a model supports and resolve it at most once.
 * @param invalidate - drop that cache. Called after a declaration write, which
 *   changes the answer `reasoningOf` gave a moment ago; without it the response
 *   to the write that just enabled levels would still say there are none.
 * @returns the route family.
 */
export function makeSettingsRoutes(ctx, llm, reasoningOf, invalidate) {
	return [
		{
			kind: 'exact',
			path: CONFIG_ROUTE,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return; }
				const method = req.method ?? 'GET';
				if (method === 'GET') { writeJson(res, 200, viewOf(ctx)); return; }
				if (method !== 'POST') { writeJson(res, 405, { error: `method not allowed: ${method}` }); return; }
				const settings = ctx.get('settings', false);
				if (settings === undefined) { writeJson(res, 503, { error: 'settings service is absent' }); return; }
				const body = await readJsonBody(req);
				if (body === undefined || !('defaults' in body)) {
					writeJson(res, 400, { error: 'invalid payload: expected defaults' });
					return;
				}
				const checked = validateDefaults(body.defaults);
				if (!checked.ok) { writeJson(res, 400, { error: 'invalid defaults payload' }); return; }
				try {
					const descriptor = settings
						.describe({ redactSecrets: true })
						.find((candidate) => String(candidate.ns) === THINK_LEVEL_SETTINGS_NAMESPACE);
					const current = descriptor?.value?.defaults ?? [];
					if (JSON.stringify(current) !== JSON.stringify(checked.defaults)) {
						await settings.update(THINK_LEVEL_SETTINGS_NAMESPACE, { defaults: checked.defaults }, descriptor?.revision);
					}
					writeJson(res, 200, viewOf(ctx));
				} catch (error) {
					writeJson(res, 409, { error: `write failed: ${String(error)}` });
				}
			},
		},
		{
			kind: 'exact',
			path: CATALOG_ROUTE,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return; }
				if (req.method !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return; }
				const providers = [];
				const models = {};
				if (llm) {
					try {
						for (const provider of (await llm.listProviders()) ?? []) {
							providers.push({ id: provider.id, name: provider.name || provider.id });
							try {
								const list = await llm.listModels(provider.id);
								models[provider.id] = (list ?? []).map((model) => ({ id: model.id, name: model.name || model.id }));
							} catch {
								// One unreachable provider must not blank the whole picker.
								models[provider.id] = [];
							}
						}
					} catch { /* fall through to an empty catalog */ }
				}
				writeJson(res, 200, { providers, models });
			},
		},
		{
			kind: 'exact',
			path: EFFORTS_ROUTE,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return; }
				if (req.method !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return; }
				const url = new URL(req.url ?? EFFORTS_ROUTE, 'http://127.0.0.1');
				const provider = url.searchParams.get('provider') ?? '';
				const model = url.searchParams.get('model') ?? '';
				if (provider === '' || model === '') { writeJson(res, 400, { error: 'expected provider and model' }); return; }
				const reasoning = await reasoningOf(provider, model);
				// A model with no reasoning metadata answers 200 with an empty
				// list, not 404: "this model cannot think harder" is an answer,
				// and the card renders it as a disabled row rather than an error.
				writeJson(res, 200, reasoning === undefined
					? { efforts: [] }
					: {
						efforts: reasoning.efforts,
						...(reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort }),
					});
			},
		},
		{
			kind: 'exact',
			path: LEVELS_ROUTE,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return; }
				const method = req.method ?? 'GET';
				if (method !== 'GET' && method !== 'POST') { writeJson(res, 405, { error: `method not allowed: ${method}` }); return; }
				const url = new URL(req.url ?? LEVELS_ROUTE, 'http://127.0.0.1');
				const provider = url.searchParams.get('provider') ?? '';
				const model = url.searchParams.get('model') ?? '';
				if (provider === '' || model === '') { writeJson(res, 400, { error: 'expected provider and model' }); return; }
				const settings = ctx.get('settings', false);
				if (method === 'GET') {
					writeJson(res, 200, levelsView(settings, await reasoningOf(provider, model), provider, model));
					return;
				}
				if (settings === undefined) { writeJson(res, 503, { error: 'settings service is absent' }); return; }
				const body = await readJsonBody(req);
				if (body === undefined || !('efforts' in body)) { writeJson(res, 400, { error: 'invalid payload: expected efforts' }); return; }
				let efforts = null;
				if (body.efforts !== null) {
					const checked = validateEfforts(body.efforts);
					if (!checked.ok) { writeJson(res, 400, { error: checked.error }); return; }
					efforts = checked.efforts;
				}
				const layers = piAiLayers(settings);
				if (layers === undefined) { writeJson(res, 503, { error: 'llm-pi-ai is not part of this composition' }); return; }
				const plan = planDeclaration(layers.resolved, layers.user, provider, model, efforts);
				if (!plan.ok) { writeJson(res, 400, { error: `cannot declare levels here: ${plan.reason}` }); return; }
				try {
					await settings.mutate(PI_AI_SETTINGS_NAMESPACE, plan.ops, layers.revision);
				} catch (error) {
					// pi-ai validates its own namespace on write, so this is
					// where a map it cannot serve lands — naming the route and
					// the model. Passing the message through verbatim is the
					// whole point of writing through the settings service
					// rather than the file.
					writeJson(res, 409, { error: `declaration refused: ${String(error?.message ?? error)}` });
					return;
				}
				// The model publishes something different now, and the cached
				// answer is one function call away from being served again.
				invalidate?.();
				writeJson(res, 200, levelsView(settings, await reasoningOf(provider, model), provider, model));
			},
		},
	];
}
