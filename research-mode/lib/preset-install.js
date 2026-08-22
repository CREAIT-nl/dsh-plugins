/**
 * Getting the `research` mode onto disk where the harness will find it.
 *
 * dsh discovers agent presets by scanning two directories: the read-only one
 * shipped inside the install, and a user-writable one at
 * `<dsh home>/.agent-presets`. A package on npm can write to neither at install
 * time, so a plugin that wants to contribute a mode syncs its own preset tree
 * into the writable root when it mounts. That is what this module does, and on
 * the roster plane it is the only thing this plugin does at all.
 *
 * The sync is idempotent and it does not fight the user. It records the hash of
 * what it wrote; on a later boot it rewrites only when the shipped files have
 * changed AND the on-disk copy still matches what this plugin last wrote. A
 * preset the user has edited is left exactly as they left it — the point of
 * putting a mode in a writable root is that it can be tuned, and an upgrade that
 * silently reverts someone's edits is a worse failure than a stale preset.
 *
 * Nothing here throws. A preset that cannot be written costs the user a mode; a
 * plugin that throws during `apply` costs them the harness.
 *
 * @module @creait/dsh-research-mode/preset-install
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dshHome } from './home.js';

/** The two files that make up a preset, per `@deepseek-ai/dsh-agent-presets`. */
const PRESET_FILES = ['preset.yml', 'agent.cordis.yml'];

/** The user-writable preset root the harness scans. */
const USER_PRESET_DIR = '.agent-presets';

/** Where this plugin remembers what it last wrote. Kept out of the preset root so it cannot confuse discovery. */
const STATE_FILE = join('.creait-research-mode', 'presets.json');

/** Preset ids must be safe directory names — the harness enforces the same shape. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/;

/** The `presets/` directory shipped inside this package. */
function shippedRoot() {
	return join(dirname(fileURLToPath(import.meta.url)), '..', 'presets');
}

/** Content hash of a preset's files, or undefined when it is not a readable preset. */
function hashPreset(dir) {
	const digest = createHash('sha256');
	let found = 0;
	for (const file of PRESET_FILES) {
		const path = join(dir, file);
		if (!existsSync(path)) continue;
		try {
			digest.update(file).update('\0').update(readFileSync(path)).update('\0');
			found += 1;
		} catch {
			return undefined;
		}
	}
	return found === PRESET_FILES.length ? digest.digest('hex') : undefined;
}

/** Read the install record, tolerating every way it can be absent or corrupt. */
function readState(home) {
	try {
		const parsed = JSON.parse(readFileSync(join(home, STATE_FILE), 'utf8'));
		return typeof parsed === 'object' && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

/** Persist the install record. Best-effort: losing it costs an unnecessary rewrite, nothing more. */
function writeState(home, state) {
	try {
		const path = join(home, STATE_FILE);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
	} catch {
		/* best-effort */
	}
}

/** Copy one preset's files into the writable root. */
function writePreset(source, target) {
	mkdirSync(target, { recursive: true });
	for (const file of PRESET_FILES) writeFileSync(join(target, file), readFileSync(join(source, file)), 'utf8');
}

/**
 * Sync every preset shipped in this package into the harness's writable preset root.
 * @param options - `{ home?, source?, logger? }`, all defaulted for production use.
 * @returns one `{ id, action }` per shipped preset: `installed`, `updated`,
 *   `current` (already identical), `kept` (locally edited, left alone) or
 *   `failed`. Returned rather than only logged so it can be asserted in tests.
 */
export function installPresets({ home = dshHome(), source = shippedRoot(), logger } = {}) {
	const results = [];
	if (!existsSync(source)) return results;

	const root = join(home, USER_PRESET_DIR);
	const state = readState(home);
	let dirty = false;

	let shipped;
	try {
		shipped = readdirSync(source, { withFileTypes: true });
	} catch {
		return results;
	}

	for (const entry of shipped) {
		if (!entry.isDirectory() || !PRESET_ID.test(entry.name)) continue;
		const id = entry.name;
		const from = join(source, id);
		const to = join(root, id);
		const shippedHash = hashPreset(from);
		if (shippedHash === undefined) continue;

		try {
			const currentHash = hashPreset(to);
			if (currentHash === shippedHash) {
				results.push({ id, action: 'current' });
				continue;
			}
			if (currentHash !== undefined && currentHash !== state[id]?.written) {
				// Edited locally. Their copy, their call.
				results.push({ id, action: 'kept' });
				logger?.info?.(`research-mode: agent preset "${id}" has local edits; leaving it as-is`);
				continue;
			}
			writePreset(from, to);
			state[id] = { written: shippedHash };
			dirty = true;
			results.push({ id, action: currentHash === undefined ? 'installed' : 'updated' });
		} catch (error) {
			results.push({ id, action: 'failed', error: String(error?.message ?? error) });
			logger?.warn?.(`research-mode: could not install agent preset "${id}": ${String(error?.message ?? error)}`);
		}
	}

	if (dirty) writeState(home, state);
	return results;
}
