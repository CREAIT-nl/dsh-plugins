/**
 * dsh-tailnet-gateway: reach a loopback-bound dsh from your own tailnet
 * devices, with the whole app working — not just the parts that survive the
 * browser-trust fence.
 *
 * The problem it solves. dsh's `/api` carrier refuses a set of privileged
 * methods (settings.*, credentials.*, agentPreset.*, host.pickDirectory,
 * llm.discoverModels) from any origin that is not loopback, and re-runs that
 * check with an EMPTY trust list, so `--trusted-host` cannot open it. Binding
 * dsh to 0.0.0.0 therefore buys a half-working app on the network and exposes
 * the LAN at the same time: Settings, Models, and Plugins fail while chat
 * works. The client half compounds it, deciding from `window.location.hostname`
 * alone that it is remote and quietly substituting a stub settings store.
 *
 * The shape of the fix. dsh stays bound to 127.0.0.1 and is never directly
 * reachable. This plugin listens on a second loopback port, and `tailscale
 * serve` publishes THAT port to the tailnet over TLS. Every request arriving
 * there has been through tailscaled, which stamps `Tailscale-User-Login` and
 * `X-Forwarded-For`, OVERWRITING whatever the client sent — that is what makes
 * the identity gate unforgeable. Requests that pass the gate are forwarded to
 * dsh as what they genuinely are: a loopback call. Requests that fail get 403
 * and never touch dsh at all.
 *
 * Two gates, both configurable from Settings → Tailnet Access:
 *
 *  1. LOGIN — the Tailscale account behind the request must be allowed. An
 *     empty list means the account that owns this node, so a single-user
 *     tailnet needs no configuration. This alone already excludes tagged
 *     servers, which have no human owner.
 *  2. DEVICE — the specific machine must be on the allowlist. Off by default,
 *     because an empty allowlist with the gate on would lock everyone out. This
 *     is what makes "my phone and my laptop, never that VPS" expressible even
 *     when the VPS is signed in as you.
 *
 * The trust this plugin holds is exactly loopback trust, so the listener is
 * clamped to a loopback address: bound to a public interface it would hand
 * that trust to anyone, because a direct caller can forge both headers itself.
 */
import { installSettingsSection } from '@deepseek-ai/dsh-settings';
import { Config, TAILNET_SETTINGS_NAMESPACE, resolveConfig } from './config.js';
import { makeTailnet } from './tailnet.js';
import { startGateway } from './gateway.js';
import { makeSettingsRoutes } from './settings-routes.js';

/** Stable cordis plugin name. */
export const name = 'tailnet-gateway';

/** Services required before surfaces mount. */
export const inject = [];

/** Settings namespace of this capability. */
export { TAILNET_SETTINGS_NAMESPACE } from './config.js';

/**
 * Mount the gateway, its settings section, and its config routes.
 * @param ctx - host plugin context.
 * @param config - plugin config from the bundle (schema defaults applied).
 */
export function apply(ctx, config) {
    let current = () => config ?? {};
    /** @param override - a candidate config to normalize instead of the live one. */
    const resolve = (override) => resolveConfig(override ?? current());
    const log = (level, message) => ctx.logger?.[level]?.('tailnet-gateway: ' + message);

    const tailnet = makeTailnet(() => resolve().statusTtlMs);

    /** The dsh webserver this gateway fronts; absent on a headless mount. */
    let webServer;
    const upstreamAuthority = () => (webServer === undefined ? '' : webServer.host + ':' + webServer.port);

    /** The live listener, plus why it is not running when it is not. */
    let live;
    let failure = '';
    const runtime = () => ({
        listening: live !== undefined,
        port: live?.port ?? resolve().port,
        host: resolve().host,
        upstream: upstreamAuthority(),
        error: failure,
    });

    /**
     * Bring the listener in line with the current config.
     *
     * Only `enabled`, `host`, and `port` need a restart — the gates and the
     * allowlists are read per request, so flipping a switch in the UI takes
     * effect on the next request rather than dropping every open connection.
     */
    let desired = '';
    async function reconcile() {
        const settings = resolve();
        if (webServer === undefined) return;
        const want = settings.enabled ? settings.host + ':' + settings.port : '';
        if (want === desired && (live !== undefined) === settings.enabled) return;
        desired = want;
        if (live !== undefined) { await live.close().catch(() => {}); live = undefined; }
        if (!settings.enabled) { log('info', 'disabled'); return; }
        try {
            live = await startGateway({
                config: resolve,
                upstream: () => ({ host: webServer.host === '0.0.0.0' ? '127.0.0.1' : webServer.host, port: webServer.port }),
                tailnet,
                log,
            });
            failure = '';
            log('info', 'listening on ' + live.host + ':' + live.port + ' -> ' + upstreamAuthority()
                + '; publish it with: tailscale serve --bg ' + live.port);
        } catch (error) {
            failure = String(error?.message ?? error);
            log('warn', 'could not start: ' + failure);
        }
    }

    installSettingsSection(ctx, TAILNET_SETTINGS_NAMESPACE, Config, config ?? {}, {
        setSource: (source) => { current = source; void reconcile(); },
        onChange: () => { void reconcile(); },
    });

    // Scoped inject so a headless mount (no web surface) installs nothing: with
    // no webserver there is no upstream to front, and the plugin should be inert
    // rather than listening on a port that leads nowhere.
    ctx.inject(['webServer'], (sctx) => {
        webServer = sctx.get('webServer');
        const disposers = makeSettingsRoutes(ctx, resolve, tailnet, runtime).map((route) => webServer.register(route));
        void reconcile();
        sctx.effect(() => () => {
            for (const dispose of disposers) dispose();
            if (live !== undefined) { void live.close().catch(() => {}); live = undefined; }
            desired = '';
            webServer = undefined;
        }, 'dsh-tailnet-gateway: gateway and config routes');
    });
}
