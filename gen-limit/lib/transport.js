/**
 * Propagate the configured stream idle timeout down to the socket.
 *
 * `llm-pi-ai` lets a provider say how long a generation may go quiet before the
 * harness gives up on it (`streamIdleTimeoutMs`), and the limiter in this
 * plugin is what makes long silences NORMAL: at capacity a request waits, and a
 * session that finally gets a slot can legitimately produce nothing for minutes
 * while it shares the backend with the sessions ahead of it. That setting is
 * the one number that decides when quiet becomes dead.
 *
 * It cannot decide it alone. The SSE stream rides Node's built-in `fetch`,
 * which is undici, whose `bodyTimeout` defaults to 300_000ms and kills any
 * response body that goes that long without a chunk. Nothing in the harness or
 * in pi-ai ever configures a dispatcher, so that default is in force and it is
 * BELOW every idle timeout worth configuring. Raising `streamIdleTimeoutMs`
 * past five minutes therefore changes nothing except which layer reports the
 * kill: the harness watchdog stops firing and undici's does instead, arriving
 * as `TypeError: terminated` / `UND_ERR_BODY_TIMEOUT`, which the adapter
 * classifies as `TRANSPORT` and the retry policy dutifully retries — from
 * scratch, discarding everything the step had already generated.
 *
 * So this module reads no new setting. It takes the `streamIdleTimeoutMs` a
 * provider already declares and pushes it to the transport that has the final
 * say, for that provider's origin only. Every other origin — MCP servers, web
 * fetches, the update check — keeps Node's defaults, because nothing about them
 * changed.
 *
 * The relaxed value is the declared one plus {@link WATCHDOG_MARGIN_MS}. The
 * two timers measure the same thing, and if they were equal the winner would be
 * a coin toss; the margin makes the harness watchdog win, so a genuinely dead
 * stream fails as `TIMEOUT` with a message that says what happened rather than
 * as an anonymous transport error. undici stays underneath as a backstop, at a
 * threshold the configuration chose instead of one it never saw.
 *
 * The seam is the one Node leaves for proxies: the built-in `fetch` has no
 * per-call timeout options, and reads its dispatcher from a global that the
 * `undici` package's `setGlobalDispatcher` writes. Verified on Node 25.8.1 with
 * undici 8.10.0 — a 3s `bodyTimeout` installed this way killed a built-in
 * `fetch` body at 3.5s where the default had taken 301s. It is a convention
 * rather than a contract, so if a future runtime stopped honouring it the
 * failure is a return to today's behaviour (killed at five minutes, retried)
 * rather than a broken harness.
 */
import { Agent, Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

/** The `llm-pi-ai` settings namespace, whose providers declare the timeout. */
export const PI_AI_NAMESPACE = 'llm-pi-ai';

/**
 * undici's own `bodyTimeout`/`headersTimeout` default. Below this there is
 * nothing to fix: the transport is already more patient than the harness.
 */
export const UNDICI_DEFAULT_TIMEOUT_MS = 300_000;

/** How much later than the harness watchdog the transport gives up. */
export const WATCHDOG_MARGIN_MS = 30_000;

/**
 * TCP keepalive probe delay for relaxed origins. Lifting `bodyTimeout` removes
 * the only thing that noticed a peer that went away without closing, so the
 * socket layer has to notice instead. Without this a dead path would hold the
 * stream open until the harness watchdog fires — correct, but as slow as the
 * timeout the user configured for a live-but-quiet stream.
 */
export const KEEPALIVE_DELAY_MS = 30_000;

/**
 * Origin of a provider's `baseURL`, or undefined when it has none or it will
 * not parse. A provider the harness reaches by some other means is simply not
 * one this can act on.
 * @param baseURL - the configured base URL.
 * @returns the origin (scheme://host:port), or undefined.
 */
export function originOf(baseURL) {
    if (typeof baseURL !== 'string' || baseURL.trim() === '') return undefined;
    try {
        return new URL(baseURL).origin;
    } catch (_unparseable) {
        return undefined;
    }
}

/**
 * The origins whose transport should outlast undici's default, and by how long.
 *
 * Reads the `llm-pi-ai` section as the user wrote it. A provider that declares
 * no `streamIdleTimeoutMs`, or declares one undici would already outlast, is
 * left alone — the point is to stop the transport from overriding an explicit
 * choice, not to relax anything nobody asked about.
 *
 * When two providers share an origin (a gateway fronting several routes) the
 * most patient one wins: the shorter timeout still belongs to the harness
 * watchdog, which is per-request and unaffected by this.
 *
 * @param section - the resolved `llm-pi-ai` settings value.
 * @returns origin -> timeout in ms, empty when nothing qualifies.
 */
export function relaxedOrigins(section) {
    const providers = section?.providers;
    const out = new Map();
    if (providers === null || typeof providers !== 'object') return out;
    for (const profile of Object.values(providers)) {
        if (profile === null || typeof profile !== 'object') continue;
        const declared = profile.streamIdleTimeoutMs;
        if (typeof declared !== 'number' || !Number.isFinite(declared)) continue;
        if (declared <= UNDICI_DEFAULT_TIMEOUT_MS) continue;
        const origin = originOf(profile.baseURL);
        if (origin === undefined) continue;
        const timeout = declared + WATCHDOG_MARGIN_MS;
        if ((out.get(origin) ?? 0) < timeout) out.set(origin, timeout);
    }
    return out;
}

/**
 * A dispatcher that sends the named origins to patient agents and everything
 * else to the agent that was global before us.
 *
 * Delegating the rest rather than substituting a fresh `Agent` matters: another
 * plugin may have installed a proxy or a mock, and this has no business
 * replacing it for origins it does not care about.
 */
class OriginRouter extends Dispatcher {
    /**
     * @param routes - origin -> dispatcher for that origin.
     * @param fallback - dispatcher for every other origin.
     */
    constructor(routes, fallback) {
        super();
        this.routes = routes;
        this.fallback = fallback;
    }

    /** @inheritdoc */
    dispatch(options, handler) {
        const route = this.routes.get(String(options?.origin ?? ''));
        return (route ?? this.fallback).dispatch(options, handler);
    }

    /** Close only what this router owns; the fallback belongs to whoever made it. */
    async close() {
        await Promise.all([...new Set(this.routes.values())].map((agent) => agent.close()));
    }

    /** @inheritdoc */
    async destroy(error) {
        await Promise.all([...new Set(this.routes.values())].map((agent) => agent.destroy(error)));
    }
}

/**
 * Install the routed dispatcher for the current settings, replacing whatever
 * this module installed before.
 *
 * Returns a teardown that puts the previous global dispatcher back, so
 * unloading the plugin leaves the process's HTTP behaviour exactly as it was.
 *
 * @param section - the resolved `llm-pi-ai` settings value.
 * @param log - optional reporter for what was applied.
 * @returns teardown restoring the previous global dispatcher, or undefined when
 *   nothing qualified and no dispatcher was installed.
 */
export function applyTransportTimeouts(section, log) {
    const origins = relaxedOrigins(section);
    if (origins.size === 0) return undefined;

    const previous = getGlobalDispatcher();
    const routes = new Map();
    for (const [origin, timeout] of origins) {
        routes.set(origin, new Agent({
            bodyTimeout: timeout,
            headersTimeout: timeout,
            connect: { keepAlive: true, keepAliveInitialDelay: KEEPALIVE_DELAY_MS },
        }));
    }
    const router = new OriginRouter(routes, previous);
    setGlobalDispatcher(router);
    log?.(origins);

    return () => {
        // Only stand down if we are still the installed dispatcher: something
        // else may have taken over since, and clobbering it would be the same
        // mistake this module exists to fix.
        if (getGlobalDispatcher() === router) setGlobalDispatcher(previous);
        // The agents may still be draining live streams. `close()` stops new
        // work and settles when they finish; a rejection here means the process
        // is going down anyway.
        void router.close().catch(() => {});
    };
}

/**
 * Keep the transport timeouts in step with the `llm-pi-ai` section, for as long
 * as this plugin is mounted.
 *
 * @param ctx - host plugin context.
 */
export function installTransportTimeouts(ctx) {
    ctx.inject(['settings'], (sctx) => {
        let teardown;
        const rebuild = () => {
            teardown?.();
            teardown = applyTransportTimeouts(sctx.settings.get(PI_AI_NAMESPACE), (origins) => {
                for (const [origin, timeout] of origins) {
                    sctx.logger?.('gen-limit')?.info?.(
                        'stream idle timeout propagated to transport: %s -> %dms', origin, timeout,
                    );
                }
            });
        };
        rebuild();
        // The section can be rewritten while the harness runs (settings file
        // edit, settings UI). Re-reading on its own namespace only: every other
        // namespace changing is none of this module's business.
        const off = sctx.on('settings/updated', (ns) => {
            if (String(ns) === PI_AI_NAMESPACE) rebuild();
        });
        sctx.effect(() => () => {
            off();
            teardown?.();
        }, 'dsh-gen-limit: transport timeouts');
    });
}
