/**
 * /api/dsh-tailnet-gateway/config — the settings page's read/write path, plus
 * /api/dsh-tailnet-gateway/devices for the device picker.
 *
 * Why plugin-owned routes instead of the settings RPC: the harness settings.*
 * wire only exposes namespaces on a hard-coded allowlist and a plugin cannot
 * widen it. The namespace IS registered host-side, so this plugin serves its
 * own endpoints and writes through the settings service.
 *
 * These routes live on the dsh webserver, behind the same loopback guard every
 * plugin route uses. Requests arriving through the gateway satisfy it, which is
 * intended: the gateway has already established who is asking, and this page is
 * exactly what a remote administrator needs to reach. Requests that reach dsh
 * any other way cannot be loopback, because dsh binds loopback only.
 *
 *   GET  /api/dsh-tailnet-gateway/config  -> view + runtime { listening, port, upstream }
 *   POST /api/dsh-tailnet-gateway/config  -> validated partial write, returns the new view
 *   GET  /api/dsh-tailnet-gateway/devices -> { devices: [...], you, ownerLogin }
 */
import { TAILNET_SETTINGS_NAMESPACE } from './config.js';
import { peerAddress, peerLogin } from './tailnet.js';
import { admit } from './gateway.js';

export const CONFIG_ROUTE = '/api/dsh-tailnet-gateway/config';
export const DEVICES_ROUTE = '/api/dsh-tailnet-gateway/devices';

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
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'referrer-policy': 'no-referrer',
    });
    res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    let overflow = false;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_JSON_BODY_BYTES) { overflow = true; continue; }
        chunks.push(chunk);
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
        .find((candidate) => String(candidate.ns) === TAILNET_SETTINGS_NAMESPACE);
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

/** A list-of-names field out of a posted body: absent means "leave it alone". */
function optionalNames(body, key) {
    if (body === undefined || body === null || !(key in body)) return { ok: true };
    const raw = body[key];
    if (!Array.isArray(raw)) return { ok: false };
    const out = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') return { ok: false };
        const trimmed = entry.trim();
        if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
    }
    return { ok: true, value: out };
}

/** An optional boolean field: absent means "leave it alone". */
function optionalFlag(body, key) {
    if (body === undefined || body === null || !(key in body)) return { ok: true };
    if (typeof body[key] !== 'boolean') return { ok: false };
    return { ok: true, value: body[key] };
}

/**
 * Build the config and devices routes.
 * @param ctx - the host plugin context (read live at request time).
 * @param resolve - thunk returning the current resolved config.
 * @param tailnet - the cached tailnet peer table.
 * @param runtime - thunk returning `{ listening, port, host, upstream, error }`.
 * @returns the route family.
 */
export function makeSettingsRoutes(ctx, resolve, tailnet, runtime) {
    return [
        {
            kind: 'exact',
            path: CONFIG_ROUTE,
            handler: async (req, res) => {
                if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return; }
                const method = req.method ?? 'GET';
                if (method === 'GET') { writeJson(res, 200, { ...viewOf(ctx), runtime: runtime() }); return; }
                if (method !== 'POST') { writeJson(res, 405, { error: `method not allowed: ${method}` }); return; }
                const settings = ctx.get('settings', false);
                if (settings === undefined) { writeJson(res, 503, { error: 'settings service is absent' }); return; }

                const body = await readJsonBody(req);
                const fields = {
                    enabled: optionalFlag(body, 'enabled'),
                    requireLogin: optionalFlag(body, 'requireLogin'),
                    deviceAllowlist: optionalFlag(body, 'deviceAllowlist'),
                    trustGatewayClients: optionalFlag(body, 'trustGatewayClients'),
                    allowedLogins: optionalNames(body, 'allowedLogins'),
                    allowedDevices: optionalNames(body, 'allowedDevices'),
                };
                const bad = Object.entries(fields).find(([, field]) => !field.ok);
                if (bad !== undefined) { writeJson(res, 400, { error: `invalid ${bad[0]} payload` }); return; }
                const patch = {};
                for (const [key, field] of Object.entries(fields)) {
                    if (field.value !== undefined) patch[key] = field.value;
                }
                // A body naming no known field is a misspelling, not a
                // deliberate no-op; answering 200 would report a write that
                // never happened.
                if (Object.keys(patch).length === 0) {
                    writeJson(res, 400, { error: 'invalid payload: no known field was set' });
                    return;
                }

                // Refuse a write that would lock out the person making it.
                // Turning on the device gate with an allowlist that omits your
                // own laptop is the obvious way to lose remote access to the
                // machine, and the only way back is a shell on it.
                const next = resolve({ ...resolve(), ...patch });
                const table = await tailnet.get();
                const arriving = peerLogin(req.headers) !== undefined || peerAddress(req.headers) !== undefined;
                if (arriving) {
                    const verdict = admit(req.headers, next, table);
                    if (!verdict.ok) {
                        writeJson(res, 400, { error: `refusing: this change would lock you out (${verdict.reason})` });
                        return;
                    }
                }

                try {
                    const descriptor = settings.describe({ redactSecrets: true })
                        .find((candidate) => String(candidate.ns) === TAILNET_SETTINGS_NAMESPACE);
                    await settings.update(TAILNET_SETTINGS_NAMESPACE, patch, descriptor?.revision);
                    writeJson(res, 200, { ...viewOf(ctx), runtime: runtime() });
                } catch (error) {
                    writeJson(res, 409, { error: `write failed: ${String(error)}` });
                }
            },
        },
        {
            kind: 'exact',
            path: DEVICES_ROUTE,
            handler: async (req, res) => {
                if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return; }
                if (req.method !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return; }
                const table = await tailnet.get();
                if (table === undefined) {
                    writeJson(res, 200, { devices: [], ownerLogin: '', available: false });
                    return;
                }
                const address = peerAddress(req.headers);
                const you = address === undefined ? undefined : table.byIp.get(address)?.name;
                writeJson(res, 200, {
                    available: true,
                    ownerLogin: table.ownerLogin,
                    you: you ?? '',
                    youLogin: peerLogin(req.headers) ?? '',
                    devices: table.devices.map((device) => ({
                        name: device.name,
                        os: device.os,
                        tagged: device.tagged,
                        tags: device.tags,
                        login: device.login,
                        online: device.online,
                        self: device.name === table.self?.name,
                    })),
                });
            },
        },
    ];
}
