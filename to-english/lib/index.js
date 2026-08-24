/**
 * dsh-to-english — automatically rewrite market-downloaded plugins' Chinese
 * copy/prompts into natural English, once at install, then live-reload the
 * rewritten plugin into the running composition.
 *
 * Host half. Three cooperating pieces:
 *
 *  1. WATCHER — watches the profile's node_modules for freshly installed
 *     plugin packages (the market installs there). A new top-level package
 *     dir with a dsh manifest is a fresh download.
 *
 *  2. TRANSLATION — for each new plugin, sends its human-facing source files
 *     (lib/*.js, client/*.js, yml, README, package.json) to the configured
 *     model through the harness `llm` service, reusing an already-configured
 *     provider/model connection (Settings → Models). The prompt is
 *     user-editable and asks for a natural English version, not a mechanical
 *     translation.
 *
 *  3. RELOAD — after rewriting, swaps the plugin's running fiber in place
 *     (the same technique as dsh-hot-reload), so the English version is live
 *     without a restart. The market hot-mounts the Chinese version first; we
 *     replace it.
 *
 * Config is persisted through the dsh settings provider (`dsh-to-english`
 * namespace). The web settings section reads/writes it via plugin-owned
 * loopback routes, and lists the live providers/models from the `llm` service.
 */
import { join } from 'node:path';
import { installSettingsSection } from '@deepseek-ai/dsh-settings';
import { Config, TO_ENGLISH_SETTINGS_NAMESPACE, resolveConfig } from './config.js';
import { translatePackage } from './translate.js';
import { reloadPackageByName } from './reload.js';
import { watchForNewPlugins, resolveProfileDir } from './watcher.js';
import { makeRoutes } from './routes.js';

/** Stable cordis plugin name. */
export const name = 'to-english';

/** Services required before surfaces mount. */
export const inject = [];

/** Settings namespace of this capability. */
export { TO_ENGLISH_SETTINGS_NAMESPACE } from './config.js';

/**
 * How long a translate+reload pipeline may run before it is abandoned. A
 * package is translated a line-range at a time, so a plugin with a Chinese
 * README is dozens of model calls rather than one — the old two-minute budget
 * expired mid-package and left the report saying nothing at all.
 */
const PIPELINE_TIMEOUT_MS = 900_000;

/**
 * Mount the watcher, translation pipeline, reload, and settings routes.
 * @param ctx - host plugin context.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx, config = {}) {
  // Settings namespace registration with consumer wiring (the gen-limit
  // pattern): while a settings service exists, register the namespace with
  // the composition entry as base and keep a live source thunk.
  let current = resolveConfig(config);
  const sync = () => {};
  installSettingsSection(ctx, TO_ENGLISH_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => { current = source(); },
    onChange: sync,
  });
  const settingsOf = () => {
    const settings = ctx.get?.('settings', false);
    if (!settings) return current;
    try {
      const descriptor = settings
        .describe({ redactSecrets: true })
        .find((candidate) => String(candidate.ns) === TO_ENGLISH_SETTINGS_NAMESPACE);
      return resolveConfig(descriptor?.value ?? current);
    } catch {
      return current;
    }
  };

  // Live status for the settings section.
  const status = {
    enabled: settingsOf().enabled,
    provider: settingsOf().provider,
    model: settingsOf().model,
    running: null,
    lastRun: null,
  };

  const profileDir = resolveProfileDir(ctx, config);
  if (!profileDir) {
    ctx.logger?.warn?.('[dsh-to-english] could not resolve profile dir; watcher inactive');
  }

  /** Translate one package dir and reload it live. */
  const pipeline = async (packageName, packageDir) => {
    const cfg = settingsOf();
    if (!cfg.enabled) {
      ctx.logger?.info?.(`[dsh-to-english] disabled — skipping ${packageName}`);
      return { status: 'disabled' };
    }
    // Live progress, so a long run is legible from the status route while it
    // is still going rather than only once it returns.
    status.running = { packageName, at: new Date().toISOString(), done: 0, total: 0, file: null };
    const onProgress = (done, total, file) => {
      if (status.running) status.running = { ...status.running, done, total, file };
    };
    let report;
    try {
      report = await withTimeout(
        translatePackage(ctx, packageDir, cfg, undefined, onProgress),
        PIPELINE_TIMEOUT_MS,
        `translation of ${packageName} timed out`,
      );
    } finally {
      status.running = null;
    }
    status.lastRun = { at: new Date().toISOString(), packageName, report };
    if (report.status === 'done' && report.translated.length > 0) {
      const reload = await reloadPackageByName(ctx, packageName);
      ctx.logger?.info?.(
        `[dsh-to-english] ${packageName}: translated ${report.translated.length} file(s) via ${report.selection.provider}/${report.selection.model}, reload=${reload}`,
      );
      return { ...report, reload };
    }
    if (report.status === 'done' && report.translated.length === 0) {
      ctx.logger?.info?.(`[dsh-to-english] ${packageName}: nothing to translate (${report.failed.length} failed)`);
    }
    return report;
  };

  /** Manual trigger from the settings section: translate one installed plugin. */
  const translateOne = async (packageName) => {
    const dir = profileDir ? join(profileDir, 'node_modules', packageName) : null;
    if (!dir) return { status: 'no-profile' };
    const report = await pipeline(packageName, dir);
    return report;
  };

  // Settings routes (loopback-only).
  const llm = ctx.get?.('llm', false);
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      // webServer.register binds one route at a time; handing it the whole
      // family registers a single malformed route and every path 404s.
      const statusOf = () => {
        const cfg = settingsOf();
        return { ...status, enabled: cfg.enabled, provider: cfg.provider, model: cfg.model };
      };
      const disposers = makeRoutes(ctx, llm, translateOne, statusOf)
        .map((route) => webCtx.webServer.register(route));
      return () => { for (const dispose of disposers) dispose(); };
    }, 'dsh-to-english: http routes');
  });

  // Watcher: translate new plugins as they appear.
  let disposeWatcher = () => {};
  if (profileDir) {
    disposeWatcher = watchForNewPlugins(ctx, profileDir, settingsOf(), async (packageName, packageDir) => {
      await pipeline(packageName, packageDir);
    });
  }

  ctx.effect(() => () => {
    disposeWatcher();
  });
}

/** Run a promise with a hard timeout, rejecting when it fires. */
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
