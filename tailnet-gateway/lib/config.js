/**
 * Plugin configuration: which tailnet peers may reach the dsh web surface
 * through this gateway, and where the gateway listens. Persisted by the dsh
 * settings provider; edited by the "Tailnet Access" settings page.
 */
import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';

/** Settings namespace of the tailnet-access capability. */
export const TAILNET_SETTINGS_NAMESPACE = settingsNamespace('dsh-tailnet-gateway');

/** Default loopback port the gateway listens on (tailscale serve proxies to it). */
export const DEFAULT_PORT = 7242;

/** How long a `tailscale status` read is reused before the peer table is re-read. */
export const DEFAULT_STATUS_TTL_MS = 30_000;

export const Config = z.object({
    enabled: z.boolean().default(true),
    // Loopback by design. The gateway is the thing that grants loopback-level
    // trust to a remote browser, so binding it to a network interface would
    // hand that trust to anyone who can reach the port.
    host: z.string().default('127.0.0.1'),
    port: z.number().step(1).min(1).max(65535).default(DEFAULT_PORT),
    // Require the Tailscale-User-Login identity that `tailscale serve` stamps.
    // A tagged device (a VPS joined with an auth key) carries no user login, so
    // this alone already separates "my devices" from "my servers".
    requireLogin: z.boolean().default(true),
    // Empty means "the login that owns this node", read from `tailscale status`.
    // Naming logins explicitly is for a shared tailnet.
    allowedLogins: z.array(z.string()).default([]),
    // Per-device gate. Off by default because an empty allowlist with the gate
    // on locks every device out, including the one turning it on.
    deviceAllowlist: z.boolean().default(false),
    /** Device names (the first DNS label, e.g. `laptop`). */
    allowedDevices: z.array(z.string()).default([]),
    // The client half of dsh-client-connection decides `isLoopback` from
    // window.location.hostname alone, so over a tailnet URL the settings pages
    // build a stub store and never issue their RPCs — the visible half of the
    // bug. With this on, the gateway states the truth about the hop it is
    // making as it serves that bundle. It is a setting, not a constant, because
    // it overrides a posture flag and an auditor should see it named.
    trustGatewayClients: z.boolean().default(true),
    statusTtlMs: z.number().step(1).min(1000).max(600_000).default(DEFAULT_STATUS_TTL_MS),
});

/** Schema defaults, re-read for hand-built test contexts. */
export const DEFAULT_CONFIG = {
    enabled: true,
    host: '127.0.0.1',
    port: DEFAULT_PORT,
    requireLogin: true,
    allowedLogins: [],
    deviceAllowlist: false,
    allowedDevices: [],
    trustGatewayClients: true,
    statusTtlMs: DEFAULT_STATUS_TTL_MS,
};

/** A bounded integer setting, falling back when the stored value is unusable. */
function counted(input, fallback, min, max) {
    const numeric = typeof input === 'number'
        ? input
        : typeof input === 'string' && input.trim() !== ''
            ? Number(input)
            : Number.NaN;
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, Math.round(numeric)));
}

/** A string array setting, with non-strings and blanks dropped rather than coerced. */
function names(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    for (const entry of input) {
        if (typeof entry !== 'string') continue;
        const trimmed = entry.trim();
        if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
    }
    return out;
}

/** Normalize a partial config against the defaults. */
export function resolveConfig(input) {
    const value = input ?? {};
    return {
        enabled: value.enabled !== false,
        // A non-loopback bind is refused here rather than honoured: this
        // gateway's whole job is to present remote requests as loopback ones,
        // so exposing it directly would publish that grant to the network.
        host: value.host === '::1' ? '::1' : '127.0.0.1',
        port: counted(value.port, DEFAULT_PORT, 1, 65535),
        requireLogin: value.requireLogin !== false,
        allowedLogins: names(value.allowedLogins),
        deviceAllowlist: value.deviceAllowlist === true,
        allowedDevices: names(value.allowedDevices),
        trustGatewayClients: value.trustGatewayClients !== false,
        statusTtlMs: counted(value.statusTtlMs, DEFAULT_STATUS_TTL_MS, 1000, 600_000),
    };
}
