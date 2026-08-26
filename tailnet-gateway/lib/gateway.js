/**
 * The tailnet-facing front door.
 *
 * dsh's `/api` carrier refuses privileged methods from anything that is not
 * loopback — a deliberate fence against DNS rebinding and cross-site calls,
 * and one that `--trusted-host` cannot open, because the privileged branch
 * re-runs the check with an EMPTY trust list. So a browser on the tailnet can
 * load the app and then fail on Settings, Models, and Plugins, which is the
 * exact half-broken shape this plugin exists to fix.
 *
 * The fix is not to widen that fence. It is to put a second front door in
 * front of it that admits only identified tailnet peers and then speaks to dsh
 * as loopback, which is what it in fact is: both ends live on this machine.
 * dsh itself stays bound to 127.0.0.1 and is never reachable directly.
 *
 * Identity comes from `tailscale serve`, which terminates TLS for the tailnet
 * and stamps `Tailscale-User-Login` on every request it forwards, OVERWRITING
 * anything the client sent. That is what makes the gate unforgeable: a peer
 * cannot name itself. Device identity comes the same way, from the peer IP in
 * `X-Forwarded-For` resolved against the tailnet peer table.
 *
 * Consequently this server MUST listen on loopback only. Bound to a public
 * interface it would hand anyone the loopback trust it is holding, since a
 * direct caller can set both headers itself. `resolveConfig` clamps the host
 * for that reason, and the listener re-checks here.
 */
import { createServer, request as httpRequest } from 'node:http';
import { peerAddress, peerLogin } from './tailnet.js';

/**
 * The bundle carrying the client half of the browser-trust posture, and the
 * one line in it that decides it.
 *
 * The client cannot be told this at runtime: `dsh-client-ui-settings` reads
 * `connection.isLoopback` inside its own `apply()`, and the connection plugin
 * computes it inside `apply()` too, so a third plugin mutating the service
 * afterwards would be racing a value that has already been read. The honest
 * place to state it is therefore the bundle itself, on its way through the one
 * component that knows the request came over an authenticated loopback hop.
 *
 * The file is served uncompressed with no ETag, and the string appears exactly
 * once, so this is a single literal substitution and not a parse. If a dsh
 * upgrade changes the line, the substitution simply does not match — the app
 * keeps working, the settings pages go back to their stub store, and the log
 * says so, which is the failure mode worth having.
 */
export const CONNECTION_BUNDLE = '/plugins/@deepseek-ai/dsh-client-connection/client.js';
const LOOPBACK_MARKER = 'isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),';
const LOOPBACK_PATCH = 'isLoopback: true,';

/** Hosts this server may bind to. Anything else forfeits the whole model. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** Headers that describe one hop and must not be forwarded to the next. */
const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/**
 * Decide whether one request may pass.
 *
 * Both gates are independent and both default to the safer reading of an
 * absent fact: no identity header means no admission when a login is
 * required, and an unresolvable peer IP means no admission when the device
 * allowlist is on. A request that arrives without either — i.e. not through
 * `tailscale serve` — therefore fails both gates rather than passing them.
 *
 * @param headers - the inbound request headers.
 * @param config - the resolved plugin config.
 * @param table - the tailnet peer table, or undefined when unreadable.
 * @returns `{ ok: true, login, device }` or `{ ok: false, reason }`.
 */
export function admit(headers, config, table) {
    const login = peerLogin(headers);
    const address = peerAddress(headers);
    const device = address === undefined ? undefined : table?.byIp.get(address);

    if (config.requireLogin) {
        // An empty allowlist means "whoever owns this node", so the common
        // single-user deployment needs no configuration to be correct.
        const allowed = config.allowedLogins.length > 0
            ? config.allowedLogins
            : (table?.ownerLogin === undefined || table.ownerLogin === '' ? [] : [table.ownerLogin]);
        if (login === undefined) {
            return { ok: false, reason: 'no Tailscale identity on this request' };
        }
        if (allowed.length === 0) {
            return { ok: false, reason: 'no allowed login is configured and this node has no owner to infer one from' };
        }
        if (!allowed.some((entry) => entry.trim().toLowerCase() === login)) {
            return { ok: false, reason: 'login ' + login + ' is not allowed' };
        }
    }

    if (config.deviceAllowlist) {
        if (device === undefined) {
            return { ok: false, reason: 'peer ' + (address ?? 'unknown') + ' is not a known tailnet device' };
        }
        if (!config.allowedDevices.some((entry) => entry.trim().toLowerCase() === device.name.toLowerCase())) {
            return { ok: false, reason: 'device ' + device.name + ' is not allowed' };
        }
    }

    return { ok: true, login, device, address };
}

/**
 * Rewrite the inbound headers for the loopback hop.
 *
 * `host`, `origin`, and `referer` all name the tailnet URL the browser typed;
 * left as they are, dsh's fence reads them as a cross-origin call. Rewriting
 * them to the upstream origin states the truth about the hop being made — the
 * request really is arriving at loopback from loopback — rather than deleting
 * them, which would also pass but would hide the relationship.
 * @param headers - the inbound headers.
 * @param upstream - the upstream authority, e.g. `127.0.0.1:7241`.
 * @returns a fresh header object for the outbound request.
 */
export function proxyHeaders(headers, upstream) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        if (HOP_BY_HOP.has(key) || value === undefined) continue;
        out[key] = value;
    }
    out.host = upstream;
    if (out.origin !== undefined) out.origin = 'http://' + upstream;
    if (typeof out.referer === 'string') {
        try {
            const referer = new URL(out.referer);
            out.referer = 'http://' + upstream + referer.pathname + referer.search;
        } catch { delete out.referer; }
    }
    return out;
}

/** Whether a request URL names the connection bundle, query string aside. */
function isConnectionBundle(url) {
    if (typeof url !== 'string') return false;
    const end = url.search(/[?#]/);
    return (end === -1 ? url : url.slice(0, end)) === CONNECTION_BUNDLE;
}

/** Buffer a response body. Only ever used on the one bundle above. */
async function collect(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

/** Say a structural problem once, not once per page load. */
const said = new Set();
function warnOnce(log, message) {
    if (said.has(message)) return;
    said.add(message);
    log('warn', message);
}

/** Refuse a request, saying why, without leaking the peer table. */
function deny(res, reason) {
    const body = 'Forbidden: ' + reason + '.\n';
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}

/**
 * Start the gateway.
 *
 * @param options.config - thunk returning the current resolved config, read
 *   per request so a settings change takes effect without a restart.
 * @param options.upstream - thunk returning the upstream `{ host, port }`.
 * @param options.tailnet - the cached peer table.
 * @param options.log - optional `(level, message)` sink.
 * @returns `{ port, close }`; `port` is the bound port (config 0 = OS-assigned).
 */
export async function startGateway({ config, upstream, tailnet, log = () => {} }) {
    const settings = config();
    if (!LOOPBACK_HOSTS.has(settings.host)) {
        throw new Error('tailnet-gateway: refusing to bind ' + settings.host + '; the gateway grants loopback trust and must not be reachable directly');
    }

    // Sockets the server has handed to us on upgrade. node stops counting a
    // connection once it is upgraded, so `close()` would wait on a tunnel that
    // by nature never ends unless we hold the reference and end it ourselves.
    const tunnels = new Set();

    const server = createServer(async (req, res) => {
        const now = config();
        const table = await tailnet.get();
        const verdict = admit(req.headers, now, table);
        if (!verdict.ok) {
            log('warn', 'denied ' + req.method + ' ' + req.url + ': ' + verdict.reason);
            deny(res, verdict.reason);
            return;
        }

        const target = upstream();
        const authority = target.host + ':' + target.port;
        const proxied = httpRequest({
            host: target.host,
            port: target.port,
            method: req.method,
            path: req.url,
            headers: proxyHeaders(req.headers, authority),
        }, (upstreamRes) => {
            const headers = { ...upstreamRes.headers };
            // Absolute redirects would send the browser to the loopback
            // authority, which does not exist on the peer's machine.
            const location = headers.location;
            if (typeof location === 'string' && location.startsWith('http://' + authority)) {
                headers.location = location.slice(('http://' + authority).length) || '/';
            }
            if (now.trustGatewayClients && isConnectionBundle(req.url) && headers['content-encoding'] === undefined) {
                collect(upstreamRes).then((body) => {
                    const text = body.toString('utf8');
                    const patched = text.replace(LOOPBACK_MARKER, LOOPBACK_PATCH);
                    if (patched === text) warnOnce(log, 'the connection bundle no longer contains the loopback marker; '
                        + 'settings pages will fall back to their stub store over the tailnet');
                    const out = Buffer.from(patched, 'utf8');
                    // The body is now one buffer of a known size, so it is no
                    // longer whatever framing the upstream chose.
                    delete headers['transfer-encoding'];
                    headers['content-length'] = String(out.length);
                    res.writeHead(upstreamRes.statusCode ?? 502, headers);
                    res.end(out);
                }).catch(() => res.destroy());
                return;
            }
            res.writeHead(upstreamRes.statusCode ?? 502, headers);
            upstreamRes.pipe(res);
        });
        proxied.on('error', (error) => {
            log('warn', 'upstream error for ' + req.url + ': ' + String(error?.message ?? error));
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Bad gateway\n');
        });
        req.pipe(proxied);
    });

    // The event stream (`events.mux`) is a WebSocket, so the same gate has to
    // exist on the upgrade path; without it the app would authenticate and
    // then sit with a dead socket.
    server.on('upgrade', async (req, socket, head) => {
        tunnels.add(socket);
        socket.once('close', () => tunnels.delete(socket));
        const now = config();
        const table = await tailnet.get();
        const verdict = admit(req.headers, now, table);
        if (!verdict.ok) {
            log('warn', 'denied upgrade ' + req.url + ': ' + verdict.reason);
            socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n');
            return;
        }
        const target = upstream();
        const headers = proxyHeaders(req.headers, target.host + ':' + target.port);
        headers.connection = 'Upgrade';
        headers.upgrade = req.headers.upgrade;
        const proxied = httpRequest({
            host: target.host,
            port: target.port,
            method: req.method,
            path: req.url,
            headers,
        });
        proxied.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
            const lines = ['HTTP/1.1 101 Switching Protocols'];
            for (const [key, value] of Object.entries(upstreamRes.headers)) {
                for (const one of Array.isArray(value) ? value : [value]) lines.push(key + ': ' + one);
            }
            socket.write(lines.join('\r\n') + '\r\n\r\n');
            // Bytes the upstream sent immediately after the 101 arrive here
            // rather than on the socket, so they have to be written on — not
            // unshifted, which would push them back into OUR read buffer and
            // strand the first frame of the event stream.
            if (upstreamHead?.length) socket.write(upstreamHead);
            upstreamSocket.pipe(socket);
            socket.pipe(upstreamSocket);
            const drop = () => { upstreamSocket.destroy(); socket.destroy(); };
            upstreamSocket.on('error', drop);
            socket.on('error', drop);
        });
        proxied.on('response', (upstreamRes) => {
            // Upstream declined the upgrade; nothing to tunnel.
            socket.end('HTTP/1.1 ' + (upstreamRes.statusCode ?? 502) + '\r\nconnection: close\r\n\r\n');
        });
        proxied.on('error', () => socket.destroy());
        if (head?.length) proxied.write(head);
        proxied.end();
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(settings.port, settings.host, () => { server.off('error', reject); resolve(); });
    });

    return {
        port: server.address()?.port ?? settings.port,
        host: settings.host,
        async close() {
            // Drop live sockets rather than waiting them out: this runs when
            // the gate has just been reconfigured, and the connections most
            // likely to be open are the long-lived event streams whose
            // admission may be exactly what changed. A tunnelled socket never
            // goes idle, so waiting would mean never closing.
            for (const socket of tunnels) socket.destroy();
            tunnels.clear();
            server.closeAllConnections();
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
