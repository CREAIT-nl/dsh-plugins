/**
 * /api/dsh-to-english/* — the settings section's read/write path.
 *
 *   GET  /api/dsh-to-english/config  -> view (value/base/user/writable/revision)
 *   POST /api/dsh-to-english/config  -> { enabled?, provider?, model?, prompt?,
 *                                        rewriteRadius?, translateEverything? }
 *   GET  /api/dsh-to-english/catalog -> { providers: [{id,name}], models: { [provider]: [{id,name}] } }
 *   POST /api/dsh-to-english/translate -> { packageName } translate + reload one
 *                                       already-installed plugin now (manual)
 *   GET  /api/dsh-to-english/status  -> { enabled, provider, model, lastRun }
 *
 * Loopback-only, mirroring the gen-limit settings-route pattern.
 */
import { TO_ENGLISH_SETTINGS_NAMESPACE } from './config.js';
import { clampRadius } from './translate.js';

/** The single route family prefix. */
export const CONFIG_ROUTE = '/api/dsh-to-english/config';
export const CATALOG_ROUTE = '/api/dsh-to-english/catalog';
export const TRANSLATE_ROUTE = '/api/dsh-to-english/translate';
export const STATUS_ROUTE = '/api/dsh-to-english/status';

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 256 * 1024;

/** Loopback guard — a settings write must never be reachable off-host. */
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
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
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
    .find((candidate) => String(candidate.ns) === TO_ENGLISH_SETTINGS_NAMESPACE);
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
 * Build the route family.
 * @param ctx - host plugin context (read live at request time).
 * @param llm - the live `llm` service or undefined.
 * @param translateOne - async (packageName) => report, for the manual trigger.
 * @param statusOf - () => { enabled, provider, model, lastRun }.
 * @returns the route family.
 */
export function makeRoutes(ctx, llm, translateOne, statusOf) {
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
        if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
        const patch = {};
        if ('enabled' in body) patch.enabled = body.enabled === true;
        if ('provider' in body) patch.provider = String(body.provider ?? '');
        if ('model' in body) patch.model = String(body.model ?? '');
        if ('prompt' in body) patch.prompt = String(body.prompt ?? '');
        // Clamped here as well as in resolveConfig: this is the write path, and a
        // radius persisted out of range would widen every future run.
        if ('rewriteRadius' in body) patch.rewriteRadius = clampRadius(body.rewriteRadius);
        // Absent means unchanged; only an explicit false turns it off, so a
        // partial patch cannot quietly re-enable Chinese preservation.
        if ('translateEverything' in body) patch.translateEverything = body.translateEverything !== false;
        if (Object.keys(patch).length === 0) { writeJson(res, 400, { error: 'invalid payload: expected enabled, provider, model, prompt, rewriteRadius or translateEverything' }); return; }
        try {
          const descriptor = settings.describe({ redactSecrets: true }).find((c) => String(c.ns) === TO_ENGLISH_SETTINGS_NAMESPACE);
          await settings.update(TO_ENGLISH_SETTINGS_NAMESPACE, patch, descriptor?.revision);
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
      path: TRANSLATE_ROUTE,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return; }
        if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return; }
        const body = await readJsonBody(req);
        const packageName = typeof body?.packageName === 'string' ? body.packageName : '';
        if (!packageName) { writeJson(res, 400, { error: 'expected packageName' }); return; }
        try {
          const report = await translateOne(packageName);
          writeJson(res, 200, { ok: true, ...report });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: 'exact',
      path: STATUS_ROUTE,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return; }
        if (req.method !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return; }
        writeJson(res, 200, statusOf());
      },
    },
  ];
}
