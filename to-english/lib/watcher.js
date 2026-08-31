/**
 * Watcher: detect freshly installed plugin packages in the profile's
 * node_modules and route them through the translation pipeline. This is the
 * "automatic on download" trigger — the market installs into
 * node_modules/<pkg>/, so a new top-level package dir with a dsh manifest is
 * a fresh install.
 *
 * The market hot-mounts the plugin right after pnpm add; our translation
 * (an LLM call) finishes after that, so the mounted version is briefly the
 * Chinese one. The reload step then swaps in the English version live.
 */
import { watch } from 'chokidar';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Packages never translated (the harness's own in-box bundles). */
const SKIP_PACKAGES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
]);

/** Our own package name — never translate ourselves. */
const SELF_NAME = '@creait/dsh-to-english';

/** How long a new package dir must be quiet before we consider it settled. */
const SETTLE_MS = 1500;

/** How long to wait before re-checking a package whose files are still changing. */
const RETRY_MS = 3000;

/**
 * Resolve the profile directory from the loader base URL (same approach as
 * dsh-hot-reload), or an explicit config override.
 */
export function resolveProfileDir(ctx, config) {
  if (config?.profileDir) return config.profileDir;
  try {
    if (ctx.baseUrl) return fileURLToPath(new URL('.', ctx.baseUrl)).replace(/\/$/, '');
  } catch { /* fall through */ }
  return null;
}

/** Whether a package dir is a plugin (has a dsh manifest field). */
export function isPluginPackage(packageDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    return manifest?.dsh !== undefined;
  } catch {
    return false;
  }
}

/** The package name from a node_modules path (handles @scope/pkg). */
export function packageNameFromPath(packageDir, nodeModulesDir) {
  const rel = packageDir.slice(nodeModulesDir.length).replace(/^[/\\]+/, '');
  return rel.split(/[/\\]/).slice(0, 2).join('/');
}

/**
 * Start watching node_modules for new plugin packages.
 * @param ctx - host context.
 * @param profileDir - absolute profile directory.
 * @param config - resolved plugin config.
 * @param onPackage - async (packageName, packageDir) => void, called for each
 *   settled new plugin package.
 * @returns a disposer that closes the watcher and pending timers.
 */
export function watchForNewPlugins(ctx, profileDir, config, onPackage) {
  const nodeModulesDir = join(profileDir, 'node_modules');
  const seen = new Set(); // package names already dispatched (or in flight)
  const timers = new Map(); // package name -> settle timer
  const retries = new Map(); // package name -> retry count
  const MAX_RETRIES = 5;

  const processPackage = (packageName, packageDir) => {
    if (seen.has(packageName)) return;
    if (SKIP_PACKAGES.has(packageName) || packageName === SELF_NAME) return;
    if (!isPluginPackage(packageDir)) return;
    seen.add(packageName);
    ctx.logger?.info?.(`[dsh-to-english] new plugin detected: ${packageName}`);
    Promise.resolve(onPackage(packageName, packageDir)).catch((error) => {
      ctx.logger?.warn?.(`[dsh-to-english] pipeline error for ${packageName}: ${error?.message ?? String(error)}`);
    });
  };

  const schedule = (packageName, packageDir, delay = SETTLE_MS) => {
    // (Re)start the settle timer; a burst of writes resets it.
    if (timers.has(packageName)) clearTimeout(timers.get(packageName));
    timers.set(packageName, setTimeout(() => {
      timers.delete(packageName);
      // The package may still be mid-write (pnpm materializes files over a
      // second or two). If it's not settled yet, retry a few times.
      if (!isPluginPackage(packageDir)) {
        const count = (retries.get(packageName) ?? 0) + 1;
        if (count <= MAX_RETRIES) {
          retries.set(packageName, count);
          schedule(packageName, packageDir, RETRY_MS);
        }
        return;
      }
      retries.delete(packageName);
      processPackage(packageName, packageDir);
    }, SETTLE_MS));
  };

  let watcher;
  try {
    watcher = watch(nodeModulesDir, {
      depth: 2,
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    });
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-to-english] could not watch node_modules: ${error?.message ?? String(error)}`);
    return () => {};
  }

  const onAddDir = (path) => {
    // Only top-level package dirs: node_modules/<pkg> or node_modules/@scope/<pkg>.
    const rel = path.slice(nodeModulesDir.length).replace(/^[/\\]+/, '');
    const parts = rel.split(/[/\\]/);
    if (parts.length < 1 || parts.length > 2) return;
    if (parts[0].startsWith('.')) return; // .pnpm, .bin, … are store plumbing
    if (parts.length === 2 && !parts[0].startsWith('@')) return; // nested non-scope dir
    if (parts.length === 1 && parts[0].startsWith('@')) return; // a scope dir is never itself a package
    const packageName = parts.join('/');
    schedule(packageName, path);
  };

  watcher.on('addDir', onAddDir);
  watcher.on('error', (error) => ctx.logger?.warn?.(`[dsh-to-english] watcher error: ${error?.message ?? String(error)}`));

  return () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    retries.clear();
    try {
      watcher.close();
    } catch { /* ignore */ }
  };
}
