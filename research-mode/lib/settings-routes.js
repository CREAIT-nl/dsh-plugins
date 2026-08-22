/**
 * /api/dsh-research-mode/config — the composer control's read/write path.
 *
 * Why a plugin-owned route instead of the settings RPC: the harness `settings.*`
 * wire only exposes namespaces on a hard-coded allowlist, and a plugin cannot
 * widen it. The namespace IS registered host-side (see `../lib/index.js`), so
 * this plugin serves its own loopback-only endpoint that reads and writes it
 * through the settings service.
 *
 *   GET  /api/dsh-research-mode/config -> view (value/base/user/writable/revision)
 *   POST /api/dsh-research-mode/config -> { width } applies a validated write and
 *                                         returns the new view
 *
 * Lifted from @creait/dsh-gen-limit's routes, deliberately: the loopback guard
 * is the part worth copying exactly rather than re-deriving, since it is what
 * keeps a settings write off the network.
 */
import { RESEARCH_SETTINGS_NAMESPACE, normalizeWidth } from './config.js';

/** The route the composer control talks to. */
export const CONFIG_ROUTE = '/api/dsh-research-mode/config';

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 16 * 1024;

/**
 * Whether a request came from this machine's own browser.
 *
 * Exported for the tests: this is the guard that keeps a config write off the
 * network, so it is the one function here worth pinning down.
 * @param request - the incoming node request.
 * @returns true when the request is loopback and same-origin.
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

/**
 * This plugin's descriptor out of the settings service.
 * @param settings - the resolved settings service.
 * @returns the descriptor, or `undefined` when the namespace is not registered.
 */
function descriptorOf(settings) {
	return settings
		.describe({ redactSecrets: true })
		.find((candidate) => String(candidate.ns) === RESEARCH_SETTINGS_NAMESPACE);
}

/** The namespace descriptor as the control needs to see it. */
export function viewOf(ctx) {
	const settings = ctx.get('settings', false);
	if (settings === undefined) return { status: 'unavailable', writable: false };
	const descriptor = descriptorOf(settings);
	if (descriptor === undefined) return { status: 'unavailable', writable: settings.writable };
	return {
		status: 'ready',
		// Normalized, so the browser never re-derives the auto sentinel or the
		// rounding: a stored 3.7 must not show as 3.7 in the field while the tool
		// runs it as 4. The client formats what it is given and nothing more.
		value: { ...descriptor.value, width: normalizeWidth(descriptor.value?.width) },
		...(descriptor.base === undefined ? {} : { base: descriptor.base }),
		...(descriptor.user === undefined ? {} : { user: descriptor.user }),
		writable: settings.writable,
		revision: descriptor.revision,
	};
}

/**
 * Build the config route.
 * @param ctx - the host plugin context (read live at request time).
 * @returns the route family.
 */
export function makeSettingsRoutes(ctx) {
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
				if (body === undefined || !('width' in body)) { writeJson(res, 400, { error: 'invalid payload: expected { width }' }); return; }
				const width = normalizeWidth(body.width);
				try {
					const descriptor = descriptorOf(settings);
					// Compare the USER layer, not `value`. `value` is base-merged-with-user,
					// so when the roster row seeds `width: 3` and the user pins 3, the merged
					// value already reads 3 and the write would be skipped — leaving nothing
					// in the user layer. Change the seed later and the pin silently evaporates.
					if (descriptor?.user?.width !== width) {
						await settings.update(RESEARCH_SETTINGS_NAMESPACE, { width }, descriptor?.revision);
					}
				} catch (error) {
					writeJson(res, 409, { error: `write failed: ${String(error)}` });
					return;
				}
				writeJson(res, 200, viewOf(ctx));
			},
		},
	];
}
