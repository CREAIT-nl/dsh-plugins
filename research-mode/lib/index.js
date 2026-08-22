/**
 * @creait/dsh-research-mode — deep research as an agent mode.
 *
 * Research that is worth the name is a fan-out: a topic decomposed into
 * independent questions, each chased by its own agent, the findings reconciled
 * and then argued with before anyone reads them. dsh has every piece of that — a
 * workflow engine, a subagent seam, web search, and (with a fetch provider
 * mounted) page reading. What it does not have is the loop, and a loop the model
 * writes fresh on each call re-earns the same structural mistakes each time:
 * work dropped when a budget runs out, the same gap chased three rounds running,
 * a report that reads as complete because nobody counted what was never looked
 * at. So the loop ships here as a fixed, reviewed script and the model supplies
 * parameters to it.
 *
 * What that loop should NOT be is a permanent tool definition and a paragraph of
 * guidance in the context of every session that has nothing to do with research.
 * dsh already resolves that: an agent preset is a composition, and a tool absent
 * from the composition does not exist for that agent. So this package ships two
 * plugin entry points and mounts on two planes.
 *
 *   ROSTER PLANE — this module, mounted by the profile bundle.
 *     Syncs the bundled `research` preset into `<dsh home>/.agent-presets` so the
 *     mode appears in the picker, registers the `dsh-research-mode` settings
 *     namespace, and serves the loopback route its composer control reads and
 *     writes. What it does NOT register is anything the model can see: no tool,
 *     no prompt section, no command, no injected service. A session on another
 *     mode gets the same system prompt and the same tool catalog it got before
 *     this package was installed — that is the claim this design has to earn,
 *     and the one worth verifying after install. The width control is browser
 *     chrome and gates itself on the session's preset, so it costs those
 *     sessions a settings namespace nobody reads and nothing else.
 *
 *   AGENT PLANE — `@creait/dsh-research-mode/tool`, mounted by the row inside
 *     `presets/research/agent.cordis.yml`. Registers `deep_research`, and only
 *     sessions that chose the mode pay for it.
 *
 * They are separate entry points rather than one module behind a config flag —
 * vet-mode's shape — because the halves need different service dependencies and
 * `inject` is a module-level declaration that gates loading. The agent half must
 * inject `workflowEngine`, which on the web surface is disabled on the host plane
 * and provided per-preset; a roster row declaring it would wait forever for a
 * service that composition never publishes, and the preset would never install.
 *
 * The loop's design — planner, adaptive rounds driven by the researchers' own
 * declared gaps, synthesis, adversarial review — is ported from
 * `dsh-deep-research` by omdsh-dev (MIT), which got the structure right. See
 * `./script.js` for what was changed and why.
 *
 * @module @creait/dsh-research-mode
 */
import { installSettingsSection } from '@deepseek-ai/dsh-settings';
import { Config, RESEARCH_SETTINGS_NAMESPACE } from './config.js';
import { installPresets } from './preset-install.js';
import { makeSettingsRoutes } from './settings-routes.js';

/** Stable Cordis plugin name. */
export const name = 'research-mode';

export { Config, RESEARCH_SETTINGS_NAMESPACE, WIDTH_AUTO, pinnedWidth } from './config.js';
export { installPresets } from './preset-install.js';
export { renderCoverage, renderReport } from './render.js';
export { PLANNER_SCHEMA, RESEARCHER_SCHEMA } from './schemas.js';
export { RESEARCH_SCRIPT } from './script.js';

/**
 * Install the mode: the preset files, the width namespace, and the route the
 * composer control uses to move it.
 * @param ctx - host plugin context.
 * @param config - the roster row's config; `{ width }`, where 0 means "no pin".
 */
export function apply(ctx, config) {
	installPresets({ logger: ctx.logger });

	// The pinned width. Persisted through the dsh settings provider so it
	// survives a restart, and read live by the AGENT half at call time — the two
	// share the namespace name and nothing else.
	//
	// Both hooks are required no-ops: the helper calls them unconditionally, and
	// there is nothing here to recompute. The tool half re-reads the namespace at
	// call time rather than caching a resolved value, so a write needs no
	// invalidation and no source to be threaded anywhere.
	installSettingsSection(ctx, RESEARCH_SETTINGS_NAMESPACE, Config, config ?? {}, {
		setSource: () => {},
		onChange: () => {},
	});

	// The control's read/write path. Registered through scoped-inject so it is
	// present only where a web server is (a headless mount registers nothing).
	ctx.inject(['webServer'], (sctx) => {
		const webServer = sctx.get('webServer');
		const disposers = makeSettingsRoutes(ctx).map((route) => webServer.register(route));
		sctx.effect(() => () => {
			for (const dispose of disposers) dispose();
		}, 'research-mode: config route');
	});
}
