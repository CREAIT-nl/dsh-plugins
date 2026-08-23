/**
 * Which tools a group claims, what the model is told about the groups it
 * cannot see, and which group a `tool_search` query resolves to.
 *
 * Everything here is a pure function over plain data so the matching and
 * rendering rules can be tested without a live Cordis tree. The plugin in
 * `./index.js` owns all wiring; this file owns all decisions.
 *
 * @module @creait/dsh-tool-disclosure/catalog
 */

import z from '@deepseek-ai/schemastery';

/** Queries that mean "stop deferring anything". */
const REVEAL_ALL = new Set(['*', 'all', 'everything']);

/**
 * Query words short enough to match half the catalog by accident. Two-letter
 * terms are dropped rather than stopword-listed: the useful ones a caller
 * types ("js", "db") are also substrings of unrelated summaries.
 */
const MIN_TERM_LENGTH = 3;

/**
 * Function words that survive {@link MIN_TERM_LENGTH} and would otherwise
 * score. A query is a sentence ("use the browser to click that"), and a
 * summary is prose, so "the" and "and" hit almost every group — which turns
 * "compile the kernel" into a match for whatever group happens to say "the".
 *
 * Only genuine function words belong here. A word that names an action the
 * model might want ("search", "read", "run") is exactly the signal this is
 * scoring on.
 */
const STOPWORDS = new Set([
	'and', 'any', 'are', 'but', 'can', 'could', 'did', 'does', 'done', 'for', 'from', 'had', 'has',
	'have', 'her', 'here', 'his', 'how', 'into', 'its', 'let', 'lets', 'may', 'might', 'more', 'most',
	'must', 'need', 'needs', 'not', 'off', 'once', 'onto', 'our', 'out', 'per', 'should', 'some',
	'than', 'that', 'the', 'their', 'them', 'then', 'there', 'they', 'this', 'through', 'use', 'used',
	'uses', 'via', 'want', 'wants', 'was', 'were', 'what', 'when', 'which', 'while', 'who', 'why',
	'will', 'with', 'would', 'you', 'your',
]);

/** One deferred capability: the tools it claims and the line the model reads. */
const Group = z.object({
	/** The name the model passes to `tool_search`. */
	id: z.string().required(),
	/** Tool-name globs (`*` only) this group claims. */
	match: z.array(z.string()).required(),
	/**
	 * What the group can do, in the model's own decision terms. This is the
	 * ONLY thing the model knows about the group before loading it, so it
	 * names capabilities ("read the console", "fill forms") rather than
	 * describing the package that provides them.
	 */
	summary: z.string().required(),
});

/** Runtime schema for the plugin row. */
const Config = z.object({
	groups: z.array(Group).default([]),
	/** Globs that are never deferred, even when a group's `match` claims them. */
	keep: z.array(z.string()).default([]),
	/**
	 * The group ids being held back. The one switch in this plugin: a group is
	 * advertised in full unless its id is named here.
	 *
	 * Ids rather than a flag inside each group, because most groups have no
	 * entry in `groups` at all — they are discovered from the registry — and
	 * because a flag would put the switch state in the same array as the
	 * definitions, where a stale copy in the user layer would mask a group
	 * added to the patch later.
	 */
	defer: z.array(z.string()).default([]),
});

/**
 * Normalize a stored config against the defaults.
 *
 * The loader validates the row's config through {@link Config}, but the
 * settings layer hands back whatever is persisted, and a teardown hands back
 * the raw entry. Reading each field defensively keeps a hand-edited
 * `settings.yaml` from turning into a crash at assembly time.
 * @param input - the stored or configured value.
 * @returns the three fields, each guaranteed to be an array.
 */
export function readConfig(input) {
	const value = input ?? {};
	return {
		groups: Array.isArray(value.groups) ? value.groups : [],
		keep: Array.isArray(value.keep) ? value.keep.map(String) : [],
		// Globs are dropped rather than escaped. A discovered group's patterns
		// are derived from its id, so `defer: ['*']` in a hand-edited file
		// would compile to a matcher claiming every tool the registry holds —
		// one entry that defers the lot, and nothing on the page saying so.
		// The settings route drops them too; this is the layer a hand edit
		// reaches without passing that route at all.
		defer: Array.isArray(value.defer) ? value.defer.map(String).filter((id) => !id.includes('*')) : [],
	};
}

/**
 * The configured groups whose switch is on.
 * @param groups - compiled groups in config order.
 * @param defer - the ids being held back.
 * @returns the deferring groups, in config order.
 */
export function deferredGroups(groups, defer) {
	if (defer.length === 0) return [];
	const wanted = new Set(defer);
	return groups.filter((group) => wanted.has(group.id));
}

/**
 * Compile one `*`-only glob into an anchored matcher. Every other regex
 * metacharacter is matched literally: tool names are `[a-z0-9_]` plus the MCP
 * `mcp__server__tool` convention, so a pattern carrying `.` or `+` is an
 * author typo rather than an intent to write a character class.
 * @param pattern - the glob as written in config.
 * @returns an anchored matcher for that glob.
 */
export function compilePattern(pattern) {
	const parts = pattern.split('*').map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, (ch) => `\\${ch}`));
	return new RegExp(`^${parts.join('.*')}$`);
}

/**
 * Compile the configured groups once, at mount.
 * @param groups - the validated `groups` config.
 * @returns matcher-carrying groups in config order.
 */
export function compileGroups(groups) {
	return groups.map((group) => ({
		id: group.id,
		summary: group.summary,
		patterns: group.match.map(compilePattern),
	}));
}

/**
 * The first group claiming a tool name. First rather than best: overlapping
 * globs are an authoring mistake, and config order is the only tiebreak an
 * author can see.
 * @param name - the registered tool name.
 * @param groups - compiled groups in config order.
 * @returns the claiming group, or undefined when none claims it.
 */
export function groupOf(name, groups) {
	for (const group of groups) {
		if (group.patterns.some((matcher) => matcher.test(name))) return group;
	}
	return undefined;
}

/**
 * The tool this plugin registers, which nothing may ever defer.
 *
 * It is the only way back: defer it and the model loses every group at once,
 * with no call left that could load one. Discovery would otherwise hand it a
 * switch of its own, since it is a registered tool no configured group claims.
 */
export const SEARCH_TOOL = 'tool_search';

/**
 * How wide a derived summary may get. A discovered group has no hand-written
 * line, so its summary is built from what it holds; past a couple of hundred
 * characters that stops being cheaper than the schemas it stands in for.
 */
const SUMMARY_MAX = 240;

/** A tool name without its `mcp__server__` prefix. */
function shortName(name) {
	const parts = name.split('__');
	return parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join('__') : name;
}

/** The first sentence of a description, capped. */
function firstSentence(text) {
	const value = typeof text === 'string' ? text.trim() : '';
	if (value === '') return '';
	const stop = value.search(/\.(\s|$)/);
	const sentence = stop === -1 ? value : value.slice(0, stop + 1);
	return sentence.length > SUMMARY_MAX ? `${sentence.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : sentence;
}

/**
 * The group id a tool falls into when no configured group claims it.
 *
 * MCP tools are named `mcp__server__tool`, so the server is a grouping the
 * deployment already made — its tools arrive and leave together, and a session
 * either needs that server or does not. Everything else stands alone: the
 * harness's own tools are unrelated to each other, and bucketing them by
 * anything would be this plugin inventing a claim it cannot support.
 * @param name - the registered tool name.
 * @returns the id of the group it belongs to.
 */
export function autoIdFor(name) {
	const parts = name.split('__');
	return parts.length >= 3 && parts[0] === 'mcp' ? parts[1] : name;
}

/**
 * Patterns for a discovered group, derived from its id alone.
 *
 * Derived rather than stored so the settings layer can hold nothing but a list
 * of ids: an MCP server that reconnects with three more tools is covered by
 * the same glob, and one that is down at boot is still deferred when it
 * returns rather than quietly advertising itself.
 * @param id - the discovered group id.
 * @returns the literal tool name and the MCP-server glob, both anchored.
 */
export function autoPatterns(id) {
	return [compilePattern(id), compilePattern(`mcp__${id}__*`)];
}

/**
 * Describe a group from the tools it holds.
 *
 * A discovered group has no authored summary, and this is what the model reads
 * before deciding to load it. Tool names carry most of the signal — `browser_click`
 * says what it does — so a multi-tool group lists them, and a lone tool falls
 * back to the first sentence of its own description.
 * @param tools - the tools in the group, carrying `name` and `description`.
 * @returns one line of prose, capped at {@link SUMMARY_MAX}.
 */
export function summarizeTools(tools) {
	if (tools.length === 0) return '';
	const names = tools.map((tool) => shortName(tool.name));
	if (tools.length === 1) {
		const sentence = firstSentence(tools[0].description);
		return sentence === '' ? names[0] : sentence;
	}
	const listed = [];
	let width = 0;
	for (const name of names) {
		if (width + name.length + 2 > SUMMARY_MAX) break;
		listed.push(name);
		width += name.length + 2;
	}
	const rest = names.length - listed.length;
	return rest === 0 ? listed.join(', ') : `${listed.join(', ')}, and ${rest} more`;
}

/**
 * Bucket everything no configured group claims, so the settings page can show
 * the whole registry rather than only the part someone wrote down.
 *
 * Kept tools are bucketed too. They can never be deferred, but leaving them
 * out would make a page that claims to list every tool quietly skip some.
 * @param tools - the live registry, carrying `name` and `description`.
 * @param configured - compiled configured groups, which win every claim.
 * @returns discovered groups in first-seen order, each carrying its tools.
 */
export function discoverGroups(tools, configured) {
	const buckets = new Map();
	for (const tool of tools) {
		if (tool.name === SEARCH_TOOL) continue;
		if (groupOf(tool.name, configured) !== undefined) continue;
		const id = autoIdFor(tool.name);
		const bucket = buckets.get(id);
		if (bucket === undefined) buckets.set(id, [tool]);
		else bucket.push(tool);
	}
	return [...buckets].map(([id, held]) => ({
		id,
		auto: true,
		patterns: autoPatterns(id),
		summary: summarizeTools(held),
		tools: held,
	}));
}

/**
 * Compile the discovered groups the user switched on, from their ids alone.
 *
 * No registry needed: the patterns come from the id, and the summary is filled
 * in per assembly from whatever the group is actually holding back then.
 * @param ids - discovered group ids from the `defer` list.
 * @returns compiled groups, summaries left to {@link withSummaries}.
 */
export function compileDiscovered(ids) {
	return [...new Set(ids)].map((id) => ({ id, auto: true, patterns: autoPatterns(id), summary: '' }));
}

/**
 * Fill in each discovered group's summary from what it is holding right now.
 *
 * Derived at read time rather than stored: a summary that described the
 * registry at boot would keep promising a tool an MCP server has since
 * dropped.
 * @param groups - compiled groups, configured and discovered.
 * @param hidden - withheld tools bucketed by group id, from {@link partition}.
 * @returns the same groups, with every discovered summary rebuilt.
 */
export function withSummaries(groups, hidden) {
	return groups.map((group) => (group.auto !== true
		? group
		: { ...group, summary: summarizeTools(hidden.get(group.id) ?? []) }));
}

/**
 * Split one tool list into what the model may see now and what each group is
 * still holding back.
 * @param tools - anything carrying `.name`: wire schemas or registry definitions.
 * @param groups - compiled groups in config order.
 * @param revealed - group ids this agent has already loaded.
 * @param keep - compiled never-defer globs.
 * @returns the surviving tools, and the withheld ones bucketed by group id.
 */
export function partition(tools, groups, revealed, keep) {
	const visible = [];
	const hidden = new Map();
	for (const tool of tools) {
		const spared = tool.name === SEARCH_TOOL || keep.some((matcher) => matcher.test(tool.name));
		const group = spared ? undefined : groupOf(tool.name, groups);
		if (group === undefined || revealed.has(group.id)) {
			visible.push(tool);
			continue;
		}
		const bucket = hidden.get(group.id);
		if (bucket === undefined) hidden.set(group.id, [tool]);
		else bucket.push(tool);
	}
	return { visible, hidden };
}

/** The instruction above the group list; see {@link renderCatalog}. */
const CATALOG_HEAD = 'Some of your tools are not listed in your tool schemas yet. Each line below is a capability you HAVE but cannot call until you load it. Call tool_search with a group name — or a few words naming the capability you need — and that group\'s tools join your tool list from your next step onward; then call them like any other tool. Never tell the user something is beyond you without searching here first.';

/**
 * Render the model-facing catalog of still-deferred groups.
 *
 * A group costs one line here against roughly a hundred tokens per tool
 * schema, which is the whole trade: the model keeps knowing what it can do and
 * stops paying for how to do it until it needs to.
 * @param hidden - withheld tools bucketed by group id, from {@link partition}.
 * @param groups - compiled groups in config order.
 * @returns the section text, or an empty string when nothing is deferred.
 */
export function renderCatalog(hidden, groups) {
	const lines = [];
	for (const group of withSummaries(groups, hidden)) {
		const count = hidden.get(group.id)?.length ?? 0;
		if (count === 0) continue;
		lines.push(`- ${group.id} (${count} tool${count === 1 ? '' : 's'}): ${group.summary}`);
	}
	if (lines.length === 0) return '';
	return [CATALOG_HEAD, ...lines].join('\n');
}

/**
 * Resolve a query to the groups it loads: the reveal-all words, else an exact
 * group id, else every group whose id or summary shares a word with the query,
 * best match first.
 *
 * Loose matching is deliberate. A query resolving to nothing costs a whole
 * round trip and teaches the model the catalog is unreliable; a query loading
 * one group too many costs that group's schemas for the rest of the session,
 * which is what it would have cost anyway had the model asked for it directly.
 * @param query - the model's `tool_search` argument.
 * @param groups - the groups still eligible to be loaded.
 * @returns matching group ids, best first; empty when nothing matches.
 */
export function resolve(query, groups) {
	const raw = query.trim().toLowerCase();
	if (raw.length === 0) return [];
	if (REVEAL_ALL.has(raw)) return groups.map((group) => group.id);
	const exact = groups.filter((group) => group.id.toLowerCase() === raw);
	if (exact.length > 0) return exact.map((group) => group.id);
	const words = raw.split(/[^a-z0-9]+/).filter((term) => term.length >= MIN_TERM_LENGTH && !STOPWORDS.has(term));
	const terms = [...new Set(words)];
	if (terms.length === 0) return [];
	return groups
		.map((group) => {
			const haystack = `${group.id} ${group.summary}`.toLowerCase();
			return { id: group.id, score: terms.filter((term) => haystack.includes(term)).length };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((entry) => entry.id);
}

export { Config, Group };
