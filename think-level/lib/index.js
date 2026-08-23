/**
 * dsh-think-level: a thinking level per provider/model, and one control to
 * change it for the session you are in.
 *
 * Host half. The harness treats reasoning effort as a per-request field and
 * offers a per-session dropdown for it, so today the answer to "how hard should
 * this model think" is re-typed in every session and never for a subagent —
 * subagents carry no model selection at all and always run at whatever the
 * provider defaults to. This plugin adds the missing layer:
 *
 *   session selection  >  this plugin's table  >  the adapter's own default
 *
 * ONE listener does it. `agent/request` is the waterfall the loop dispatches
 * once per step to "replace the frozen call configuration", and it is the last
 * seam before `llm.prepareCall` materializes adapter defaults — so at this
 * point `reasoningEffort === undefined` genuinely means nobody has chosen, not
 * "nobody has chosen yet". The listener is PREPENDED so it runs outermost,
 * which puts its post-`next()` rewrite after everything registered later
 * (notably `installModelSelection`, which re-derives the session's effort on
 * every step) — and then it declines to touch an effort that is already set.
 * Outermost is the position that lets it see the final answer; filling only a
 * hole is what keeps the session's own choice winning.
 *
 * The listener is registered untagged, so the scope carrier admits it for every
 * agent (see @deepseek-ai/dsh-scope `scopeTarget`: untagged listeners are
 * global). That is how subagents are covered without a second code path — they
 * reach the same waterfall, with nothing in the effort field, and take the
 * table's answer.
 *
 * What it will NOT do is send an effort the model does not publish:
 * `llm.prepareCall` rejects an unsupported id with UNSUPPORTED_REASONING_EFFORT
 * and the turn dies. A stale row — the model was reconfigured, the adapter
 * changed its levels — is therefore dropped and the request goes out exactly as
 * it would have without this plugin.
 *
 * Config is persisted through the dsh settings provider (`dsh-think-level`
 * namespace) and edited from the Settings page and the composer pill, both of
 * which read it over the plugin-owned loopback routes in ./settings-routes.js
 * (the harness settings wire only exposes namespaces on its own allowlist,
 * which a plugin cannot widen).
 */
import { installSettingsSection } from '@deepseek-ai/dsh-settings';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { Config, THINK_LEVEL_SETTINGS_NAMESPACE, effortFor, keyOf, resolveConfig } from './config.js';
import { installGlobalEffortUnpin } from './global-default.js';
import { makeSettingsRoutes } from './settings-routes.js';

/** Stable cordis plugin name. */
export const name = 'think-level';

/** Services required before surfaces mount. */
export const inject = [];

/** Settings namespace of this capability. */
export { THINK_LEVEL_SETTINGS_NAMESPACE } from './config.js';

/**
 * Mount the request listener and its persistence/route wiring.
 * @param ctx - host plugin context.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx, config) {
	let current = () => config ?? {};
	const resolve = () => resolveConfig(current());

	/**
	 * provider\0model -> the model's reasoning metadata, resolved once.
	 *
	 * Only SUCCESSES are cached. Caching a failure would turn one unreachable
	 * provider into a permanently opinion-free model: the row would sit in the
	 * table looking applied while every request quietly skipped it until the
	 * process restarted.
	 */
	const reasoningCache = new Map();

	const reasoningOf = (provider, model, signal) => {
		const key = keyOf(provider, model);
		const hit = reasoningCache.get(key);
		if (hit !== undefined) return hit;
		const llm = ctx.get('llm', false);
		if (llm === undefined) return Promise.resolve(undefined);
		const pending = Promise.resolve(llm.resolveModelInfo(provider, model, signal))
			.then((info) => info?.reasoning)
			.catch(() => { reasoningCache.delete(key); return undefined; });
		reasoningCache.set(key, pending);
		return pending;
	};

	// Fill in the thinking level when nothing else chose one.
	//
	// Prepended (the trailing `true`) so this runs outermost and its rewrite is
	// the last word — see the module comment. Everything inside the try is
	// best-effort: a throw here would take down the turn over a settings row,
	// so any surprise leaves the request exactly as the rest of the chain
	// assembled it.
	ctx.on('agent/request', async (payload, next) => {
		const resolved = await next();
		try {
			if (resolved?.reasoningEffort !== undefined) return resolved;
			if (typeof resolved?.provider !== 'string' || typeof resolved?.model !== 'string') return resolved;
			const effort = effortFor(resolve(), resolved.provider, resolved.model);
			if (effort === undefined) return resolved;
			const reasoning = await reasoningOf(resolved.provider, resolved.model, payload?.signal);
			if (reasoning === undefined) return resolved;
			if (!reasoning.efforts.some((level) => String(level.id) === effort)) return resolved;
			return { ...resolved, reasoningEffort: ReasoningEffortId(effort) };
		} catch {
			return resolved;
		}
	}, true);

	// An adapter's namespace decides what its models publish, so a write there
	// — this plugin declaring levels for a hand-declared model, or somebody
	// editing settings.yaml with the server up — moves the answer this cache
	// holds. Matching on the `llm-` prefix keeps every adapter covered without
	// naming them; unrelated namespaces move constantly and must not cost a
	// re-resolve.
	ctx.on('settings/document-updated', (ns) => {
		if (String(ns).startsWith('llm-')) reasoningCache.clear();
	});

	const sync = () => {
		// The listener reads `resolve()` live, so a table edit needs no
		// re-registration. The model metadata behind it can move for the same
		// reason a row does (a provider reconfigured under the same id), and a
		// settings write is the only moment worth paying a re-resolve for.
		reasoningCache.clear();
	};

	installSettingsSection(ctx, THINK_LEVEL_SETTINGS_NAMESPACE, Config, config ?? {}, {
		setSource: (source) => { current = source; sync(); },
		onChange: sync,
	});

	// The harness pins the adapter's own default effort into the global default
	// model selection on every model switch, and a new session inherits it —
	// which would leave the listener above no hole to fill. See ./global-default.js.
	// Scoped-inject because the unpin reads the namespace the moment it mounts,
	// and at `apply` time the settings service is not up yet.
	ctx.inject(['settings'], (sctx) => { installGlobalEffortUnpin(sctx); });

	// Plugin-owned routes for the Settings page and the composer pill.
	// Registered through scoped-inject so they exist only where a webserver
	// does; a headless mount keeps the listener and mounts no surface.
	ctx.inject(['webServer'], (sctx) => {
		const webServer = sctx.get('webServer');
		const routes = makeSettingsRoutes(
			ctx,
			ctx.get('llm', false),
			(provider, model) => reasoningOf(provider, model),
			() => reasoningCache.clear(),
		);
		const disposers = routes.map((route) => webServer.register(route));
		sctx.effect(() => () => {
			for (const dispose of disposers) dispose();
		}, 'dsh-think-level: config routes');
	});
}
