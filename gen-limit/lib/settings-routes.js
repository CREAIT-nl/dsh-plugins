/**
 * /api/dsh-gen-limit/config — the settings card's read/write path, plus
 * /api/dsh-gen-limit/catalog and /api/dsh-gen-limit/stats for the card.
 *
 * Why a plugin-owned route instead of the settings RPC: the harness
 * settings.* wire only exposes namespaces on a hard-coded allowlist; a plugin
 * cannot widen it. The namespace IS registered host-side, so this plugin
 * serves its own loopback-only endpoints that read/write it through the
 * settings service.
 *
 *   GET  /api/dsh-gen-limit/config -> view (value/base/user/writable/revision)
 *   POST /api/dsh-gen-limit/config -> { limits: [...replace-all...], queueTimeoutMs?,
 *                                     maxQueued? } applies a validated write,
 *                                     returns the new view
 *   GET  /api/dsh-gen-limit/catalog -> { providers: [{id,name}], models: { [provider]: [{id,name}] } }
 *   GET  /api/dsh-gen-limit/stats  -> { entries: [{provider, model, active, waiting}] }
 */
import { GENLIMIT_SETTINGS_NAMESPACE } from './config.js';

/** The single route family prefix. */
export const CONFIG_ROUTE = '/api/dsh-gen-limit/config';
export const CATALOG_ROUTE = '/api/dsh-gen-limit/catalog';
export const STATS_ROUTE = '/api/dsh-gen-limit/stats';

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 128 * 1024;

// Exported for the tests: this is the guard that keeps a config write off the
// network, so it is the one function here worth pinning down.
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
        .find((candidate) => String(candidate.ns) === GENLIMIT_SETTINGS_NAMESPACE);
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
 * An optional non-negative integer field out of a posted body.
 *
 * Absent means "leave it alone", which is why this cannot simply be `Number()`:
 * `Number(undefined)` is NaN but `Number(null)` and `Number('')` are 0, and 0 is
 * a meaningful setting here (it disables the wait timeout). A field that is
 * present but unusable is a bad request, not a silent zero.
 * @param body - the parsed request body.
 * @param key - the field name.
 * @returns `{ ok }` with `value` when the field was present and valid.
 */
export function optionalCount(body, key) {
    if (body === undefined || body === null || !(key in body)) return { ok: true };
    const raw = body[key];
    const numeric = typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim() !== ''
            ? Number(raw)
            : Number.NaN;
    if (!Number.isFinite(numeric) || numeric < 0) return { ok: false };
    return { ok: true, value: Math.round(numeric) };
}

function validateLimits(limits) {
    if (!Array.isArray(limits)) return { ok: false };
    const out = [];
    for (const entry of limits) {
        if (typeof entry !== 'object' || entry === null) return { ok: false };
        const provider = String(entry.provider ?? '');
        const model = String(entry.model ?? '');
        if (!provider || !model) return { ok: false };
        let max = Number(entry.max);
        if (!Number.isFinite(max)) max = -1;
        out.push({ provider, model, max: Math.round(max) });
    }
    return { ok: true, limits: out };
}

/**
 * Build the config/catalog/stats routes.
 * @param ctx - the host plugin context (read live at request time).
 * @param resolve - thunk returning the current resolved config.
 * @param activeThunk - thunk returning the live active-sessions Map (key -> Set).
 * @param llm - the live `llm` service or undefined.
 * @param queue - the live admission queue, for the waiting counts (optional).
 * @returns the route family.
 */
export function makeSettingsRoutes(ctx, resolve, activeThunk, llm, queue) {
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
                // `limits` is optional so the queue knobs can be posted on their
                // own. Requiring it would make every timeout edit re-send a
                // limits array the card read some time ago, which is how a
                // concurrent change to the limits gets silently reverted.
                const hasLimits = body !== undefined && body !== null && 'limits' in body;
                const checked = hasLimits ? validateLimits(body.limits) : { ok: true };
                if (!checked.ok) { writeJson(res, 400, { error: 'invalid limits payload' }); return; }
                const timeout = optionalCount(body, 'queueTimeoutMs');
                const queued = optionalCount(body, 'maxQueued');
                if (!timeout.ok || !queued.ok) { writeJson(res, 400, { error: 'invalid queue payload' }); return; }
                // A body naming none of them is a misspelled field, not a
                // deliberate no-op. Answering 200 to it would report a write
                // that never happened.
                if (!hasLimits && timeout.value === undefined && queued.value === undefined) {
                    writeJson(res, 400, { error: 'invalid payload: expected limits, queueTimeoutMs or maxQueued' });
                    return;
                }
                try {
                    // Replace the whole `limits` array atomically against the current revision.
                    const descriptor = settings.describe({ redactSecrets: true }).find((c) => String(c.ns) === GENLIMIT_SETTINGS_NAMESPACE);
                    const current = (descriptor?.value?.limits ?? []);
                    const patch = {};
                    if (hasLimits && JSON.stringify(current) !== JSON.stringify(checked.limits)) patch.limits = checked.limits;
                    // Compare against the USER layer, not the merged value: with a
                    // roster-seeded base, re-posting the seeded number would look
                    // unchanged and leave the user layer empty, so a later change to
                    // the seed would silently move a setting the user had pinned.
                    if (timeout.value !== undefined && descriptor?.user?.queueTimeoutMs !== timeout.value) patch.queueTimeoutMs = timeout.value;
                    if (queued.value !== undefined && descriptor?.user?.maxQueued !== queued.value) patch.maxQueued = queued.value;
                    if (Object.keys(patch).length > 0) {
                        await settings.update(GENLIMIT_SETTINGS_NAMESPACE, patch, descriptor?.revision);
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
                        const list = await llm.listProviders();
                        for (const p of list ?? []) {
                            providers.push({ id: p.id, name: p.name || p.id });
                            try {
                                const mlist = await llm.listModels(p.id);
                                models[p.id] = (mlist ?? []).map((m) => ({ id: m.id, name: m.name || m.id }));
                            } catch {
                                models[p.id] = [];
                            }
                        }
                    } catch { /* fall through to empty */ }
                }
                writeJson(res, 200, { providers, models });
            },
        },
        {
            kind: 'exact',
            path: STATS_ROUTE,
            handler: async (req, res) => {
                if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return; }
                if (req.method !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return; }
                const entries = [];
                const map = activeThunk();
                // Union of the two, not just the busy ones: a model can have
                // a line waiting on a limit that was just lowered under it, and
                // a queue depth that only appears once something is already
                // streaming would hide exactly the state worth seeing.
                const keys = new Set(map.keys());
                for (const key of queue?.keys?.() ?? []) keys.add(key);
                for (const key of keys) {
                    const sep = key.indexOf('\u0000');
                    entries.push({
                        provider: key.slice(0, sep),
                        model: key.slice(sep + 1),
                        active: map.get(key)?.size ?? 0,
                        waiting: queue?.waiting?.(key) ?? 0,
                    });
                }
                writeJson(res, 200, { entries });
            },
        },
    ];
}
