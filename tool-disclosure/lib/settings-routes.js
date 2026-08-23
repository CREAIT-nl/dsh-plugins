/**
 * The settings page's read/write path, plus the live measurement it shows.
 *
 * Why plugin-owned routes rather than the settings RPC: the harness
 * `settings.*` wire only exposes namespaces on a hard-coded allowlist, which a
 * plugin cannot widen. The namespace IS registered host-side, so this serves
 * its own loopback-only endpoints that read and write it through the settings
 * service — the same shape `dsh-gen-limit` uses.
 *
 *   GET  /api/dsh-tool-disclosure/config -> view (value/base/user/writable/revision)
 *   POST /api/dsh-tool-disclosure/config -> { defer } (replace-all), returns the new view
 *   GET  /api/dsh-tool-disclosure/groups -> every group the registry holds, with what each one
 *                                           costs, measured now
 *
 * @module @creait/dsh-tool-disclosure/settings-routes
 */
import { settingsNamespace } from '@deepseek-ai/dsh-settings';

import { compileGroups, compilePattern, discoverGroups, groupOf, readConfig } from './catalog.js';

/** Settings namespace of this capability. */
export const TOOL_DISCLOSURE_SETTINGS_NAMESPACE = settingsNamespace('dsh-tool-disclosure');

export const CONFIG_ROUTE = '/api/dsh-tool-disclosure/config';
export const GROUPS_ROUTE = '/api/dsh-tool-disclosure/groups';

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 128 * 1024;

/**
 * Characters of tool-schema JSON per input token.
 *
 * Calibrated rather than guessed: mounting the Playwright MCP server added
 * 18,502 characters of `tools/list` JSON and moved a live session's input
 * count by 4,443 tokens, which is 4.16. It is an estimate either way — the
 * provider tokenizes the wire format, not this JSON — so the settings page
 * shows it as an approximation and shows the character count beside it.
 */
const CHARS_PER_TOKEN = 4.16;

/** Rough token count for a measured character count. */
export function tokensFor(chars) {
	return Math.round(chars / CHARS_PER_TOKEN);
}

/**
 * The loopback guard. A settings write must not be reachable from the network,
 * and this is the only thing standing between the two, so it is the one
 * function here worth pinning down in tests.
 * @param request - the incoming request.
 * @returns whether it came from this machine, same-origin.
 */
export function isLoopbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
	const host = request.headers.host;
	if (typeof host !== 'string') return false;
	let hostUrl;
	try { hostUrl = new URL(`http://${host}`); } catch { return false; }
	if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false;
	if (request.headers['sec-fetch-site'] === 'cross-site') return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}

function writeJson(res, status, body) {
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'referrer-policy': 'no-referrer',
	});
	res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	let overflow = false;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_JSON_BODY_BYTES) { overflow = true; continue; }
		chunks.push(chunk);
	}
	if (overflow) return undefined;
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
	} catch { return undefined; }
}

/** The settings descriptor for this namespace, or undefined. */
function descriptorOf(ctx) {
	const settings = ctx.get('settings', false);
	if (settings === undefined) return undefined;
	return settings
		.describe({ redactSecrets: true })
		.find((candidate) => String(candidate.ns) === TOOL_DISCLOSURE_SETTINGS_NAMESPACE);
}

function viewOf(ctx) {
	const settings = ctx.get('settings', false);
	if (settings === undefined) return { status: 'unavailable', writable: false };
	const descriptor = descriptorOf(ctx);
	if (descriptor === undefined) return { status: 'unavailable', writable: settings.writable };
	return {
		status: 'ready',
		value: descriptor.value,
		...(descriptor.base === undefined ? {} : { base: descriptor.base }),
		...(descriptor.user === undefined ? {} : { user: descriptor.user }),
		writable: settings.writable,
		revision: descriptor.revision,
	};
}

/**
 * What the page prints under a group's name.
 *
 * An annotated group has a hand-written summary. A discovered one has a
 * derived summary, and for more than one tool that summary IS the tools' short
 * names — which the page lists for itself, so printing both would say the same
 * thing twice. A lone tool is the exception: its derived summary is its own
 * first sentence, unless it has no description at all and the summary is just
 * the name again.
 * @param group - a discovered group, carrying its schemas.
 * @returns the summary to show, or '' to show none.
 */
function pageSummary(group) {
	if (group.tools.length !== 1 || group.summary === group.id) return '';
	return group.summary;
}

/**
 * Measure every group the live registry holds.
 *
 * Deliberately measured rather than remembered, and discovered rather than
 * listed. The point of the settings page is to let someone decide whether a
 * group is worth deferring, and that decision turns on what the harness is
 * actually carrying now: an MCP server that grew three tools since the config
 * was written costs three tools more, and one that nobody annotated at all is
 * exactly the cost this page exists to expose.
 *
 * The global registry view is the right one to read: it is the union every
 * agent draws from, so the numbers do not depend on which session happens to
 * be open, and a per-agent view would report a group as free the moment that
 * agent had loaded it.
 * @param ctx - the host plugin context.
 * @param config - the live merged config.
 * @returns per-group measurements plus the totals they sit against.
 */
export function measureGroups(ctx, config) {
	const value = readConfig(config);
	const groups = compileGroups(value.groups);
	const keep = value.keep.map(compilePattern);
	const defer = new Set(value.defer);
	const kept = (name) => keep.some((matcher) => matcher.test(name));

	const tools = ctx.get('tools', false);
	const schemas = typeof tools?.schemas === 'function' ? tools.schemas() : [];

	const measured = new Map(groups.map((group) => [group.id, { summary: group.summary, tools: 0, chars: 0, kept: 0, unclaimed: 0, names: [] }]));
	let totalChars = 0;
	for (const schema of schemas) {
		const chars = JSON.stringify(schema).length;
		totalChars += chars;
		const group = groupOf(schema.name, groups);
		if (group === undefined) continue;
		const entry = measured.get(group.id);
		entry.names.push(schema.name);
		// A kept tool is counted against its group's total but not against
		// what deferring the group would save — `keep` wins over `match`, so
		// that tool is advertised either way.
		if (kept(schema.name)) { entry.kept += 1; continue; }
		entry.tools += 1;
		entry.chars += chars;
	}

	// Everything no annotated group claims, bucketed by MCP server or standing
	// alone. Same kind of row, same switch: the annotation is a better id, a
	// hand-written summary and globs of its own, not a different concept.
	for (const group of discoverGroups(schemas, groups)) {
		const deferrable = group.tools.filter((schema) => !kept(schema.name));
		// An annotation whose globs cover only part of the bucket its id names
		// leaves the rest discovered under that same id. `sync()` gives the
		// annotation the id outright, so the switch defers what the annotation
		// claims and nothing else: the leftovers belong on that row — a page
		// that promises every tool cannot drop them — but not in what it says
		// deferring would save.
		const annotated = measured.get(group.id);
		if (annotated !== undefined) {
			annotated.names.push(...group.tools.map((schema) => schema.name));
			annotated.unclaimed += group.tools.length;
			continue;
		}
		measured.set(group.id, {
			summary: pageSummary(group),
			tools: deferrable.length,
			chars: deferrable.reduce((sum, schema) => sum + JSON.stringify(schema).length, 0),
			kept: group.tools.length - deferrable.length,
			unclaimed: 0,
			names: group.tools.map((schema) => schema.name),
		});
	}

	const rows = [...measured]
		.map(([id, entry]) => ({
			id,
			summary: entry.summary,
			deferred: defer.has(id),
			tools: entry.tools,
			kept: entry.kept,
			unclaimed: entry.unclaimed,
			names: entry.names,
			chars: entry.chars,
			tokens: tokensFor(entry.chars),
		}))
		// Costliest first. The page exists to answer "what is worth deferring",
		// and that is the order that answers it; config order answers "what did
		// someone write down", which is not a question the page is asking. Ties
		// break on id so a re-measure that changed nothing does not reshuffle
		// the list under someone's cursor.
		.sort((a, b) => b.chars - a.chars || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	const held = rows.filter((row) => row.deferred);
	const deferredChars = held.reduce((sum, row) => sum + row.chars, 0);
	return {
		groups: rows,
		// The shared registry, which is not everything one session advertises:
		// on the web surface each agent preset mounts its own copies of the
		// mode tools, and those never appear in a global view. So this is a
		// floor for a session's tool list — the page says as much rather than
		// deriving a "still advertised" figure that would be wrong.
		total: {
			tools: schemas.length,
			chars: totalChars,
			tokens: tokensFor(totalChars),
		},
		deferred: {
			tools: held.reduce((sum, row) => sum + row.tools, 0),
			chars: deferredChars,
			tokens: tokensFor(deferredChars),
		},
	};
}

/** Bounds on the id list, which is not checked against the registry. */
const MAX_DEFER_IDS = 512;
const MAX_ID_CHARS = 128;

/**
 * Validate the posted switch state.
 *
 * The ids are not checked against the registry, or against the patch. A group
 * exists only while the thing behind it does — an MCP server has to be
 * connected to be discovered — so filtering against what is registered right
 * now would quietly clear the switch of every server that happened to be down,
 * and each would come back advertised. An id matching nothing defers nothing
 * and costs nothing; an id whose group returns keeps the decision someone made
 * about it.
 * @param body - the parsed request body.
 * @returns `{ ok }` with the list when the field was present and usable.
 */
export function validateDefer(body) {
	if (body === undefined || body === null) return { ok: false };
	const { defer } = body;
	// Required rather than defaulted: reading a missing field as [] would
	// advertise every group at once, which is the opposite of a no-op.
	if (!Array.isArray(defer)) return { ok: false };
	return {
		ok: true,
		defer: [...new Set(defer.map(String))]
			// An id is a name, never a pattern. A discovered group's globs are
			// derived from its id, so a `*` in one compiles to a matcher that
			// claims every tool the registry holds — one entry that silently
			// defers the lot. `keep` and `match` are where globs belong.
			.filter((id) => id.length > 0 && id.length <= MAX_ID_CHARS && !id.includes('*'))
			.slice(0, MAX_DEFER_IDS),
	};
}

/**
 * Whether two id lists name the same groups, order aside.
 *
 * The lists are sets wearing array clothes — both sides are deduped — so a
 * reorder is not a change, and treating it as one would burn a settings
 * revision to persist a value nothing reads differently.
 * @param a - one list of ids.
 * @param b - the other.
 * @returns whether they hold the same ids.
 */
export function sameIds(a, b) {
	if (a.length !== b.length) return false;
	const held = new Set(a);
	return b.every((id) => held.has(id));
}

/**
 * Build the config and measurement routes.
 * @param ctx - the host plugin context, read live at request time.
 * @param source - thunk returning the current merged config.
 * @returns the route family.
 */
export function makeSettingsRoutes(ctx, source) {
	return [
		{
			kind: 'exact',
			path: CONFIG_ROUTE,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return; }
				const method = req.method ?? 'GET';
				if (method === 'GET') { writeJson(res, 200, viewOf(ctx)); return; }
				if (method !== 'POST') { writeJson(res, 405, { error: `method not allowed: ${method}` }); return; }
				const settings = ctx.get('settings', false);
				if (settings === undefined) { writeJson(res, 503, { error: 'settings service is absent' }); return; }
				const body = await readJsonBody(req);
				const checked = validateDefer(body);
				if (!checked.ok) { writeJson(res, 400, { error: 'invalid payload: expected { defer: string[] }' }); return; }
				try {
					const descriptor = descriptorOf(ctx);
					// Compare against the USER layer, not the merged value: a
					// group the patch already defers reads the same either way,
					// so comparing the merged value would leave the user layer
					// empty and let a later patch edit silently move a switch
					// someone had set by hand.
					const user = descriptor?.user ?? {};
					if (!sameIds(Array.isArray(user.defer) ? user.defer.map(String) : [], checked.defer)) {
						await settings.update(TOOL_DISCLOSURE_SETTINGS_NAMESPACE, { defer: checked.defer }, descriptor?.revision);
					}
					writeJson(res, 200, viewOf(ctx));
				} catch (error) {
					writeJson(res, 409, { error: `write failed: ${String(error)}` });
				}
			},
		},
		{
			kind: 'exact',
			path: GROUPS_ROUTE,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return; }
				if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return; }
				writeJson(res, 200, measureGroups(ctx, source()));
			},
		},
	];
}
