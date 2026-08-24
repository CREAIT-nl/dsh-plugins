/**
 * Live reload of a rewritten plugin, replicating the technique from
 * dsh-hot-reload (which itself mirrors cordis-plugin-hmr): invalidate the
 * package's cached modules, re-import the new code, and swap the running
 * plugin fiber in place — no restart.
 *
 * This is what makes "translate once at install" actually take effect in the
 * running composition: the market hot-mounts the freshly installed plugin
 * (Chinese), we rewrite its files, then swap the fiber so the English version
 * is live immediately.
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const getOuterStack = () => [];
const cjsRequire = createRequire(import.meta.url);

/** Resolve a specifier to a file URL through the loader's resolver. */
async function resolveUrl(internal, specifier, parentURL) {
  const attrs = {};
  let res;
  try {
    switch (internal.version) {
      case 'v1':
        res = await internal.resolve(specifier, parentURL, attrs);
        break;
      case 'v2':
        res = internal.resolveSync(parentURL, { specifier, attributes: attrs });
        break;
      default:
        if (typeof internal.resolve === 'function') res = await internal.resolve(specifier, parentURL, attrs);
        else if (typeof internal.resolveSync === 'function') res = internal.resolveSync(parentURL, { specifier, attributes: attrs });
        else throw new Error('loader.internal exposes no resolver');
    }
  } catch (error) {
    throw new Error(`could not resolve ${specifier}: ${error?.message ?? String(error)}`);
  }
  return typeof res === 'string' ? res : res?.url;
}

/** Invalidate one module URL from both the ESM load cache and the CJS cache. */
function invalidate(internal, url) {
  try {
    Map.prototype.delete.call(internal.loadCache, url);
  } catch { /* ignore */ }
  try {
    const fp = fileURLToPath(url);
    if (cjsRequire.cache[fp]) delete cjsRequire.cache[fp];
  } catch { /* ignore */ }
}

/** Directory URL (trailing slash) of the nearest ancestor with a package.json. */
function packageRootUrlOf(url) {
  let dir = dirname(fileURLToPath(url));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) {
      const href = pathToFileURL(dir).href;
      return href.endsWith('/') ? href : `${href}/`;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Invalidate every cached module under one package directory. */
function invalidateTree(internal, rootUrl) {
  if (!rootUrl) return;
  try {
    for (const u of Map.prototype.keys.call(internal.loadCache)) {
      if (typeof u === 'string' && u.startsWith(rootUrl)) {
        Map.prototype.delete.call(internal.loadCache, u);
      }
    }
  } catch { /* ignore */ }
  try {
    const rootPath = fileURLToPath(rootUrl);
    for (const fp of Object.keys(cjsRequire.cache)) {
      if (fp.startsWith(rootPath)) delete cjsRequire.cache[fp];
    }
  } catch { /* ignore */ }
}

/** Re-attach a plugin to an old fiber's entry + config. */
function reattach(plugin, oldFiber) {
  const fiber = oldFiber.parent.registry.plugin(plugin, oldFiber._config, getOuterStack);
  fiber.entry = oldFiber.entry;
  if (fiber.entry) fiber.entry.fiber = fiber;
  return fiber;
}

/**
 * Reload one loaded loader entry in place. On failure the old plugin is
 * rolled back (the running plugin is never left dead).
 * @param ctx - host context (loader + registry).
 * @param entry - the loader entry to reload.
 * @returns the imported module's package version, or null.
 */
export async function reloadEntry(ctx, entry) {
  const loader = ctx.loader;
  const internal = loader?.internal;
  const specifier = entry?.options?.name;
  const parentURL = entry?.parent?.tree?.ctx?.baseUrl ?? ctx.baseUrl;
  const oldFiber = entry.fiber;
  const runtime = oldFiber?.runtime;
  const oldPlugin = runtime?.callback;
  if (!oldPlugin || !runtime) throw new Error(`no live fiber for ${specifier}`);

  const url = await resolveUrl(internal, specifier, parentURL);
  if (!url) throw new Error(`could not resolve ${specifier}`);

  // Drop the whole package directory, not just the entry: under a hoisted
  // linker a rewrite changes files in place (same URLs), so the entry's
  // relative imports would otherwise re-hit the stale cache and mix old and
  // new code.
  const rootUrl = packageRootUrlOf(url);
  if (rootUrl) invalidateTree(internal, rootUrl);
  else invalidate(internal, url);

  const newPlugin = loader.unwrapExports(await loader.import(url, getOuterStack));
  if (!newPlugin) throw new Error(`fresh import produced no plugin for ${specifier}`);

  // Snapshot fibers before disposal, then swap: dispose old (runs ctx
  // disposers), re-instantiate the new plugin against each old fiber.
  const fibers = [...runtime.fibers];
  ctx.registry.delete(oldPlugin);
  try {
    const fresh = fibers.map((of) => reattach(newPlugin, of));
    await Promise.all(fresh.map((f) => f?.await?.()));
  } catch (err) {
    try {
      ctx.registry.delete(newPlugin);
    } catch { /* ignore */ }
    // Roll back so a failed reload never leaves the plugin dead.
    const restored = [];
    for (const of of fibers) {
      try {
        restored.push(reattach(oldPlugin, of));
      } catch { /* ignore */ }
    }
    try {
      await Promise.all(restored.map((f) => f?.await?.()));
    } catch { /* ignore */ }
    throw err;
  }
  return true;
}

/**
 * Find the loader entry backing a package name (the market hot-mounts and
 * bundle rows both carry `options.name` = package name).
 * @param ctx - host context.
 * @param packageName - the installed package name.
 * @returns the first matching live entry, or null.
 */
export function findEntryForPackage(ctx, packageName) {
  const loader = ctx.loader;
  if (!loader || typeof loader.entries !== 'function') return null;
  for (const entry of loader.entries()) {
    if (entry?.options?.name === packageName && entry?.fiber) return entry;
  }
  return null;
}

/**
 * Reload a package by name if it is currently live in the composition.
 * @returns 'reloaded' | 'not-live' | 'failed'.
 */
export async function reloadPackageByName(ctx, packageName) {
  const entry = findEntryForPackage(ctx, packageName);
  if (!entry) return 'not-live';
  try {
    await reloadEntry(ctx, entry);
    return 'reloaded';
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-to-english] reload of ${packageName} failed: ${error?.message ?? String(error)}`);
    return 'failed';
  }
}
