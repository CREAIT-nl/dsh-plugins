/**
 * The tailnet peer table, read from `tailscale status --json`.
 *
 * The gateway needs two facts per request: which device sent it, and which
 * user owns that device. `tailscale serve` stamps the user on every proxied
 * request (`Tailscale-User-Login`) but names no device, so the device comes
 * from `X-Forwarded-For` — the peer's tailnet IP — resolved against this table.
 *
 * Reading the CLI rather than the local API socket on purpose: the socket path
 * and its auth differ across platforms and packaging, while `tailscale status`
 * is stable, unprivileged, and already on PATH wherever tailscaled runs.
 */
import { execFile } from 'node:child_process';

/** How long one `tailscale status` read is reused. Overridden by config. */
const FALLBACK_TTL_MS = 30_000;

/** Cap on the CLI's output so a wedged binary cannot grow the heap. */
const MAX_STATUS_BYTES = 4 * 1024 * 1024;

/** How long the CLI gets before the read is abandoned. */
const STATUS_TIMEOUT_MS = 5_000;

/** The short device name: the first label of the MagicDNS name. */
function shortName(dnsName, fallback) {
    if (typeof dnsName !== 'string' || dnsName === '') return fallback ?? '';
    const label = dnsName.split('.')[0];
    return label === '' ? (fallback ?? '') : label;
}

/**
 * One peer row out of the `tailscale status --json` shape.
 * @param node - a `Self` or `Peer[*]` object.
 * @param users - the status document's `User` table (id -> profile).
 * @returns the normalized device.
 */
function deviceOf(node, users) {
    const tags = Array.isArray(node?.Tags) ? node.Tags : [];
    const profile = users?.[String(node?.UserID ?? '')] ?? undefined;
    return {
        name: shortName(node?.DNSName, node?.HostName),
        ips: Array.isArray(node?.TailscaleIPs) ? node.TailscaleIPs.filter((ip) => typeof ip === 'string') : [],
        os: typeof node?.OS === 'string' ? node.OS : '',
        // A tagged node is a server joined with an auth key: it has no human
        // owner, and `LoginName` reads as the synthetic `tagged-devices`.
        tagged: tags.length > 0,
        tags,
        login: typeof profile?.LoginName === 'string' ? profile.LoginName : '',
        online: node?.Online === true,
    };
}

/**
 * Parse a `tailscale status --json` document into the peer table.
 * Exported for the tests, which is where the shape is pinned.
 * @param text - raw CLI stdout.
 * @returns `{ self, devices, ownerLogin, byIp }`, or undefined when unusable.
 */
export function parseStatus(text) {
    let document;
    try { document = JSON.parse(text); } catch { return undefined; }
    if (typeof document !== 'object' || document === null) return undefined;
    const users = typeof document.User === 'object' && document.User !== null ? document.User : {};
    const self = document.Self === undefined ? undefined : deviceOf(document.Self, users);
    const peers = typeof document.Peer === 'object' && document.Peer !== null ? Object.values(document.Peer) : [];
    const devices = peers.map((peer) => deviceOf(peer, users)).filter((device) => device.name !== '');
    if (self !== undefined && self.name !== '') devices.push(self);
    devices.sort((a, b) => a.name.localeCompare(b.name));
    const byIp = new Map();
    for (const device of devices) {
        for (const ip of device.ips) byIp.set(ip, device);
    }
    return {
        self,
        devices,
        // The login that owns THIS node, which is the sensible default for
        // "my account" without the deployment having to name it.
        ownerLogin: self?.tagged === false ? self.login : '',
        byIp,
    };
}

/** Run `tailscale status --json` once. */
function readStatus() {
    return new Promise((resolve) => {
        execFile(
            'tailscale',
            ['status', '--json'],
            { timeout: STATUS_TIMEOUT_MS, maxBuffer: MAX_STATUS_BYTES, windowsHide: true },
            (error, stdout) => resolve(error ? undefined : parseStatus(String(stdout))),
        );
    });
}

/**
 * A TTL-cached peer table.
 *
 * Cached because every proxied request resolves a device and the CLI is a
 * process spawn; stale-on-error because a tailscaled restart must not lock out
 * the devices that were already allowed — an allowlist that fails open on a
 * missing table would be worse, so a failed refresh keeps the LAST table
 * rather than an empty one.
 * @param ttl - thunk returning the current TTL in ms.
 * @param now - clock, injectable for the tests.
 * @param read - status reader, injectable for the tests.
 */
export function makeTailnet(ttl = () => FALLBACK_TTL_MS, now = () => Date.now(), read = readStatus) {
    let cached;
    let readAt = 0;
    let inflight;
    const refresh = async () => {
        if (inflight !== undefined) return inflight;
        inflight = read().then((next) => {
            if (next !== undefined) { cached = next; readAt = now(); }
            inflight = undefined;
            return cached;
        }).catch(() => { inflight = undefined; return cached; });
        return inflight;
    };
    return {
        /** The table, refreshed when the TTL has passed. Never rejects. */
        async get() {
            if (cached === undefined || now() - readAt >= ttl()) await refresh();
            return cached;
        },
        /** The table as last read, without triggering a refresh. */
        peek() { return cached; },
        /** Force the next `get()` to re-read. */
        invalidate() { readAt = 0; },
    };
}

/**
 * The peer IP `tailscale serve` recorded for a proxied request.
 *
 * `X-Forwarded-For` may carry a list when something else proxied first; the
 * FIRST entry is the original client. Reading the last would let a client that
 * can set the header choose its own identity.
 * @param headers - the request headers.
 * @returns the peer IP, or undefined.
 */
export function peerAddress(headers) {
    const raw = headers['x-forwarded-for'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') return undefined;
    const first = value.split(',')[0]?.trim();
    if (first === undefined || first === '') return undefined;
    // A bracketed IPv6 literal, and any :port suffix a proxy may have added.
    if (first.startsWith('[')) return first.slice(1, first.indexOf(']') > 0 ? first.indexOf(']') : undefined);
    const parts = first.split(':');
    return parts.length === 2 ? parts[0] : first;
}

/** The Tailscale identity header serve stamps, lowercased, or undefined. */
export function peerLogin(headers) {
    const raw = headers['tailscale-user-login'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim().toLowerCase();
    return trimmed === '' ? undefined : trimmed;
}
