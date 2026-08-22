/**
 * Where the harness keeps its writable state.
 *
 * One function, in its own module, because both the preset installer and its
 * tests need it and neither should import the other's concerns to get it.
 *
 * @module @creait/dsh-research-mode/home
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the dsh home directory.
 * @returns `$DSH_HOME` when set, else `~/.dsh` — the same rule the harness uses.
 */
export function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}
