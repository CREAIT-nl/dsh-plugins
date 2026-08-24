/**
 * Hook declaration schema, filter matching, and payload templating.
 *
 * Everything in this module is a pure function over plain data so the matching
 * and rendering rules can be tested without a live Cordis tree. The engine in
 * `./index.js` owns all I/O; this file owns all decisions.
 *
 * @module @creait/dsh-hookkit/config
 */

import z from '@deepseek-ai/schemastery';

/**
 * Events a hook may subscribe to. `agent/pre-step` and `tools/post-execute` are
 * the two that can contribute context; `tools/pre-execute` is the only one that
 * can deny; the `session/*` family is observe-only.
 */
const HOOK_EVENTS = [
	'agent/pre-step',
	'tools/pre-execute',
	'tools/post-execute',
	'turn/start',
	'turn/end',
	'step/start',
	'step/end',
	'tool/call',
	'tool/result',
	'compaction/start',
	'compaction/summary',
	'compaction/end',
	'user/message',
	'approval/asked',
];

/** Events whose handler output can be injected as model-visible context. */
const INJECTING_EVENTS = new Set(['agent/pre-step', 'tools/post-execute']);

/** The only event whose handler can block the thing it fires on. */
const DENYING_EVENT = 'tools/pre-execute';

/** The only event whose payload carries a user-turn count. */
const TURN_COUNTING_EVENT = 'agent/pre-step';

/** Default per-handler wall-clock budget. */
const DEFAULT_TIMEOUT_MS = 8000;

/** Default cap on injected text, in characters. */
const DEFAULT_MAX_CHARS = 1500;

const Filter = z.object({
	/** Only fire on step 1 of a turn — the "once per user turn" case. */
	firstStep: z.boolean().default(false),
	/** Only fire when the step carries a fresh user-authored message. */
	hasUserMessage: z.boolean().default(false),
	/**
	 * Only fire on the session's first user turn — the "prime once, then let the
	 * model ask" case. Counted from the derived history rather than tracked in
	 * memory, so a mid-session plugin reload cannot re-arm it.
	 */
	firstTurn: z.boolean().default(false),
	/** Tool-name globs; empty means every tool. */
	tools: z.array(z.string()).default([]),
	/** Field -> regex source; every entry must match for the hook to fire. */
	match: z.dict(z.string()).default({}),
	/** `turn/end` reason kinds to accept; empty means every reason. */
	reason: z.array(z.string()).default([]),
});

const Handler = z.object({
	/** In-harness tool to invoke, e.g. `mcp__mem0__search_memory`. */
	tool: z.string().default(''),
	/** Arguments for `tool`, templated against the event payload. */
	arguments: z.dict(z.any()).default({}),
	/** Shell command; receives the JSON payload on stdin, stdout is the output. */
	run: z.string().default(''),
	/** HTTP endpoint; receives the JSON payload as a POST body. */
	http: z.string().default(''),
});

const Inject = z.object({
	/**
	 * What to do with handler output. `context` makes it model-visible,
	 * `deny` blocks the tool call (pre-execute only), `none` discards it.
	 */
	as: z.union(['context', 'deny', 'none']).default('none'),
	/** Wrapper applied to the output; `{{output}}` is the handler's text. */
	template: z.string().default('{{output}}'),
	/** Hard cap on injected characters; the text is truncated, never dropped. */
	maxChars: z.number().step(1).min(1).default(DEFAULT_MAX_CHARS),
	/** Skip injection entirely when the handler produced nothing. */
	skipIfEmpty: z.boolean().default(true),
	/** Short label shown in the transcript instead of the raw payload. */
	summary: z.string().default('hookkit'),
});

const Hook = z.object({
	id: z.string(),
	on: z.union(HOOK_EVENTS),
	enabled: z.boolean().default(true),
	when: Filter.default({}),
	do: Handler.default({}),
	inject: Inject.default({}),
	timeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS),
	/** When true (the default) a handler failure is logged and ignored. */
	failOpen: z.boolean().default(true),
});

/**
 * How much of the conversation `{{conversationTail}}` carries.
 *
 * A query built from the user's words alone loses the referent of "ok do it";
 * a query built from the whole preceding assistant turn is worse still, because
 * long prose embeds to a centroid that matches nothing in particular. Head plus
 * tail keeps what the turn was about and what it concluded, and drops the
 * middle, which is where the noise lives.
 */
const Tail = z.object({
	/** Characters kept from the start of the last assistant message. */
	assistantHead: z.number().step(1).min(0).default(600),
	/** Characters kept from its end; the middle is elided. */
	assistantTail: z.number().step(1).min(0).default(300),
});

const Config = z.object({
	hooks: z.array(Hook).default([]),
	/** Shape of the `{{conversationTail}}` template variable. */
	conversationTail: Tail.default({}),
	/** Log every hook decision to the console; noisy, for debugging only. */
	debug: z.boolean().default(false),
});

/**
 * Translate a `*`/`?` glob into an anchored regular expression.
 * @param pattern - the glob source.
 * @returns an anchored `RegExp` equivalent to the glob.
 */
function globToRegExp(pattern) {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

/**
 * Validate one hook's event/outcome pairing and pre-compile its patterns.
 *
 * Rejecting an impossible pairing here — a `deny` on an event that cannot deny,
 * a `context` injection on an observe-only event — turns a hook that would have
 * silently done nothing at runtime into a startup error naming the hook.
 *
 * @param hook - one validated {@link Hook} entry.
 * @returns the hook plus its compiled `toolPatterns` and `matchPatterns`.
 * @throws when the declaration cannot ever fire as written.
 */
function compileHook(hook) {
	const handlers = ['tool', 'run', 'http'].filter((kind) => hook.do[kind].length > 0);
	if (handlers.length !== 1) {
		throw new Error(
			`hookkit: hook "${hook.id}" must declare exactly one of do.tool / do.run / do.http (found ${handlers.length === 0 ? 'none' : handlers.join(', ')})`,
		);
	}
	if (hook.inject.as === 'deny' && hook.on !== DENYING_EVENT) {
		throw new Error(
			`hookkit: hook "${hook.id}" uses inject.as: deny, which only "${DENYING_EVENT}" supports (got "${hook.on}")`,
		);
	}
	if (hook.inject.as === 'context' && !INJECTING_EVENTS.has(hook.on)) {
		throw new Error(
			`hookkit: hook "${hook.id}" uses inject.as: context, which only ${[...INJECTING_EVENTS].join(' / ')} support (got "${hook.on}")`,
		);
	}
	if (hook.when.firstTurn && hook.on !== TURN_COUNTING_EVENT) {
		throw new Error(
			`hookkit: hook "${hook.id}" uses when.firstTurn, which only "${TURN_COUNTING_EVENT}" can evaluate (got "${hook.on}")`,
		);
	}
	return {
		...hook,
		kind: handlers[0],
		toolPatterns: hook.when.tools.map(globToRegExp),
		matchPatterns: Object.entries(hook.when.match).map(([field, source]) => [field, new RegExp(source)]),
	};
}

/**
 * Compile every enabled hook, grouped by the event that fires it.
 * @param config - the validated plugin {@link Config}.
 * @returns a map of event name to the hooks listening on it, in declared order.
 * @throws when any hook declaration is invalid, naming the offending hook.
 */
function compileHooks(config) {
	const byEvent = new Map();
	const seen = new Set();
	for (const hook of config.hooks) {
		if (!hook.enabled) continue;
		if (seen.has(hook.id)) throw new Error(`hookkit: duplicate hook id "${hook.id}"`);
		seen.add(hook.id);
		const compiled = compileHook(hook);
		const bucket = byEvent.get(compiled.on);
		if (bucket === undefined) byEvent.set(compiled.on, [compiled]);
		else bucket.push(compiled);
	}
	return byEvent;
}

/**
 * Whether a hook's filters admit this payload.
 *
 * A field named in `when.match` but absent from the payload never matches, so a
 * typo silences the hook rather than firing it on everything.
 *
 * @param hook - a hook returned by {@link compileHooks}.
 * @param payload - the flattened event payload (see `buildPayload`).
 * @returns true when every declared filter passes.
 */
function matches(hook, payload) {
	if (hook.when.firstStep && payload.step !== 1) return false;
	if (hook.when.hasUserMessage && payload.hasUserMessage !== true) return false;
	if (hook.when.firstTurn && payload.userTurn !== 1) return false;
	if (hook.toolPatterns.length > 0) {
		const tool = payload.tool;
		if (typeof tool !== 'string' || !hook.toolPatterns.some((pattern) => pattern.test(tool))) return false;
	}
	if (hook.when.reason.length > 0 && !hook.when.reason.includes(payload.reason)) return false;
	for (const [field, pattern] of hook.matchPatterns) {
		const value = payload[field];
		if (typeof value !== 'string' || !pattern.test(value)) return false;
	}
	return true;
}

/**
 * Substitute `{{name}}` references from a payload.
 *
 * Unknown references render as the empty string: a template is configuration,
 * and a missing optional field (no tool on a turn event, say) should thin the
 * text rather than abort the hook.
 *
 * @param template - the template source.
 * @param payload - the value map.
 * @returns the rendered string.
 */
function render(template, payload) {
	return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
		const value = payload[key];
		if (value === undefined || value === null) return '';
		return typeof value === 'string' ? value : JSON.stringify(value);
	});
}

/**
 * Recursively render every string leaf of a tool-argument object.
 * @param value - the argument tree from `do.arguments`.
 * @param payload - the value map.
 * @returns a structurally identical tree with templated strings.
 */
function renderDeep(value, payload) {
	if (typeof value === 'string') return render(value, payload);
	if (Array.isArray(value)) return value.map((entry) => renderDeep(entry, payload));
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renderDeep(entry, payload)]));
	}
	return value;
}

/**
 * Clip text to a character budget, marking the cut so a truncated injection is
 * never mistaken for the whole record.
 * @param text - the text to clip.
 * @param maxChars - the inclusive character budget.
 * @returns the text, clipped and marked when it exceeded the budget.
 */
function clip(text, maxChars) {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n…[hookkit: truncated at ${maxChars} chars]`;
}

export {
	Config,
	DEFAULT_MAX_CHARS,
	DEFAULT_TIMEOUT_MS,
	DENYING_EVENT,
	HOOK_EVENTS,
	INJECTING_EVENTS,
	Tail,
	clip,
	compileHook,
	compileHooks,
	globToRegExp,
	matches,
	render,
	renderDeep,
};
