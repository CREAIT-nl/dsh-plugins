/**
 * Config-driven lifecycle hooks for DeepSeek Harness.
 *
 * dsh has no declarative hook layer of its own: the seams exist as ordered
 * Cordis waterfalls (`agent/pre-step`, `tools/pre-execute`, `tools/post-execute`)
 * and a session event stream, but reaching them means shipping a plugin. This
 * plugin turns those seams into YAML you declare in `cordis.patch.yml`.
 *
 * It differs from the two hook plugins already in the market in the one way that
 * matters for memory: a hook here can **contribute context**. `dsh-hooks` is
 * fire-and-forget and `dsh-plugin-hooks` can only deny, so neither can hand text
 * back to the model. A `inject.as: context` hook does exactly that, and because
 * the `tool` handler calls an in-harness tool, mem0 recall stays on MCP with no
 * second process and no second handshake.
 *
 * Three handler kinds, one contract:
 *   do.tool  — invoke a registered tool (MCP tools included) in-process
 *   do.run   — spawn a shell command, JSON payload on stdin (Claude Code shape)
 *   do.http  — POST the payload to an endpoint
 *
 * Three outcomes:
 *   inject.as: context — the output becomes a model-visible message
 *   inject.as: deny    — a failing handler blocks the tool call
 *   inject.as: none    — fire and forget
 *
 * @module @creait/dsh-hookkit
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { Config, clip, compileHooks, matches, render } from './config.js';
import { runHandler } from './handlers.js';

/** Cordis plugin name used by loader diagnostics. */
const name = 'hookkit';

/**
 * Services this plugin needs before its listeners can mean anything. `shell` and
 * `tools` are injected rather than probed so the loader waits for them instead
 * of silently registering hooks that would no-op on the first turn.
 */
const inject = ['tools', 'shell'];

/** Marks messages this plugin authored, so the transcript attributes them. */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'hookkit' };

/** Session events the `session/event` family forwards to hooks. */
const SESSION_EVENTS = new Set([
	'turn/start',
	'turn/end',
	'step/start',
	'step/end',
	'tool/call',
	'tool/result',
	'compaction/start',
	'compaction/end',
	'user/message',
	'approval/asked',
]);

/**
 * Concatenate the text blocks of one message.
 * @param message - a session message.
 * @returns the joined text, or the empty string when it carries none.
 */
function messageText(message) {
	const blocks = Array.isArray(message?.content) ? message.content : [];
	return blocks
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n')
		.trim();
}

/**
 * The text of the most recent human-authored message in a step's message list.
 *
 * Plugin-authored notices (including this plugin's own injections) carry a
 * non-`user` source kind, so a recall query built from this can never feed on
 * the previous turn's injected memories.
 *
 * @param messages - the step's claimed messages.
 * @returns the last user message's text, or the empty string.
 */
function lastUserText(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.source?.kind !== 'user') continue;
		const text = messageText(message);
		if (text.length > 0) return text;
	}
	return '';
}

/**
 * The text of the most recent model-authored message.
 * @param messages - the messages to scan, oldest first.
 * @returns the last assistant message's text, or the empty string.
 */
function lastAssistantText(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.source?.kind !== 'model') continue;
		const text = messageText(message);
		if (text.length > 0) return text;
	}
	return '';
}

/**
 * How many user-authored turns the conversation has reached, this one included.
 *
 * Counted rather than remembered: a hook that primes the session once has to
 * stay primed across a plugin reload, and a counter held in the plugin would
 * re-arm every time the harness rebuilds it.
 *
 * @param messages - the merged conversation, oldest first.
 * @returns the number of user-authored messages.
 */
function countUserTurns(messages) {
	let count = 0;
	for (const message of messages) {
		if (message?.source?.kind === 'user') count += 1;
	}
	return count;
}

/** Stands in for the dropped middle of an abridged message. */
const ELISION = '\n[...]\n';

/**
 * Keep a text's head and tail, dropping the middle.
 * @param text - the text to abridge.
 * @param head - characters to keep from the start.
 * @param tail - characters to keep from the end.
 * @returns the text, abridged and marked, or unchanged when it already fits.
 */
function abridge(text, head, tail) {
	if (head + tail >= text.length) return text;
	return `${text.slice(0, head).trimEnd()}${ELISION}${text.slice(text.length - tail).trimStart()}`;
}

/**
 * What the agent last said, abridged, followed by what the user just replied.
 *
 * `{{userText}}` alone is a poor recall query for the common case: "ok do it"
 * carries none of the nouns the thing to do was named with, so it retrieves
 * whatever the store happens to score highest. Pairing it with the surrounding
 * assistant turn restores the referent. The middle of that turn is dropped
 * rather than summarised — the opening says what was being worked on and the
 * closing says what it concluded, and everything between is transcript.
 *
 * @param messages - the conversation, oldest first.
 * @param options - `assistantHead` / `assistantTail` character budgets.
 * @returns the rendered tail, or the empty string when there is nothing to say.
 */
function conversationTail(messages, options = {}) {
	const head = options.assistantHead ?? 600;
	const tail = options.assistantTail ?? 300;
	const parts = [];
	const assistant = head + tail > 0 ? lastAssistantText(messages) : '';
	if (assistant.length > 0) parts.push(`ASSISTANT: ${abridge(assistant, head, tail)}`);
	const user = lastUserText(messages);
	if (user.length > 0) parts.push(`USER: ${user}`);
	return parts.join('\n\n');
}

/**
 * The full model-visible history plus whatever this step just claimed.
 *
 * A step's `messages` are only the newly claimed ones, so on their own they
 * cannot show what the agent said last turn. `deriveMessages()` is the session's
 * canonical projection of that history — cached and deep-frozen, so calling it
 * per step is cheap — but the fresh user message may still be in the inbox and
 * absent from it, hence the merge. Falls back to the claimed messages alone if
 * the session cannot answer, which keeps hooks working under a test harness.
 *
 * @param agent - the agent this step belongs to.
 * @param claimed - the messages this step claimed.
 * @returns the merged conversation, oldest first, without duplicates.
 */
function sessionMessages(agent, claimed) {
	let history;
	try {
		history = agent?.session?.deriveMessages?.();
	} catch {
		history = undefined;
	}
	if (!Array.isArray(history) || history.length === 0) return claimed;
	const seen = new Set(history.map((message) => message?.id).filter((id) => id !== undefined));
	return [...history, ...claimed.filter((message) => message?.id === undefined || !seen.has(message.id))];
}

/**
 * Build the flattened value map a hook's filters, templates, and payload all
 * read from. Keys prefixed `__` are engine-internal and never leave the process.
 *
 * @param base - event-specific fields.
 * @param agent - the agent this event belongs to, when there is one.
 * @returns the payload map.
 */
function buildPayload(base, agent) {
	const session = agent?.session;
	return {
		timestamp: new Date().toISOString(),
		sessionId: session?.id ?? '',
		cwd: session?.cwd ?? '',
		...base,
		__agent: agent,
	};
}

/**
 * Run every hook registered for an event and collect the injectable texts.
 *
 * Hooks run concurrently: they are independent by construction, and a recall
 * hook that waits on a notify hook would put a webhook's latency on the critical
 * path of every turn. Failures are contained per hook so one broken declaration
 * cannot take down the others.
 *
 * @param ctx - the plugin context.
 * @param hooks - the compiled hooks for this event.
 * @param payload - the flattened event payload.
 * @param signal - cancellation for this batch.
 * @param debug - whether to log each decision.
 * @returns `{ texts, denial }` — rendered injections, and the first deny reason.
 */
async function fireHooks(ctx, hooks, payload, signal, debug) {
	const applicable = hooks.filter((hook) => matches(hook, payload));
	if (applicable.length === 0) return { texts: [], denial: undefined };
	const outcomes = await Promise.all(
		applicable.map(async (hook) => {
			const result = await runHandler(ctx, hook, payload, signal);
			if (debug) ctx.logger?.info?.(`hookkit ${hook.id} (${hook.on}): ${result.detail}`);
			return { hook, result };
		}),
	);
	const texts = [];
	let denial;
	for (const { hook, result } of outcomes) {
		if (!result.ok && !hook.failOpen && hook.inject.as !== 'deny') {
			ctx.logger?.warn?.(`hookkit ${hook.id} failed (failOpen: false): ${result.detail}`);
		}
		if (hook.inject.as === 'deny') {
			if (!result.ok && denial === undefined) {
				denial = result.output.length > 0 ? result.output : `blocked by hook "${hook.id}": ${result.detail}`;
			}
			continue;
		}
		if (hook.inject.as !== 'context') continue;
		if (!result.ok && hook.failOpen) continue;
		if (hook.inject.skipIfEmpty && result.output.length === 0) continue;
		const rendered = render(hook.inject.template, { ...payload, output: result.output }).trim();
		if (rendered.length === 0) continue;
		texts.push({ hook, text: clip(rendered, hook.inject.maxChars) });
	}
	return { texts, denial };
}

/**
 * Wrap one hook's rendered text as a plugin-authored user message.
 * @param entry - a `{ hook, text }` pair from {@link fireHooks}.
 * @returns the message to place in front of the model.
 */
function toMessage(entry) {
	return createUserMessage({
		content: [{ type: 'text', text: entry.text }],
		source: { ...PLUGIN_SOURCE, form: 'notice', summary: entry.hook.inject.summary },
	});
}

/**
 * Install the declared hooks.
 * @param ctx - plugin context; every listener is scoped to it and disposed with it.
 * @param config - the validated {@link Config}.
 */
function apply(ctx, config) {
	const byEvent = compileHooks(config);
	if (byEvent.size === 0) return;
	const debug = config.debug;

	const preStepHooks = byEvent.get('agent/pre-step') ?? [];
	if (preStepHooks.length > 0) {
		ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
			const decision = await next();
			if (decision.kind === 'reject') return decision;
			const history = sessionMessages(agent, messages);
			const payload = buildPayload(
				{
					event: 'agent/pre-step',
					step,
					userText: lastUserText(messages),
					conversationTail: conversationTail(history, config.conversationTail),
					userTurn: countUserTurns(history),
					hasUserMessage: messages.some((message) => message?.source?.kind === 'user'),
				},
				agent,
			);
			const { texts } = await fireHooks(ctx, preStepHooks, payload, signal, debug);
			if (texts.length === 0) return decision;
			signal.throwIfAborted();
			// Append after the messages this step already claimed so the injected
			// context is the last thing the model reads before it acts.
			return { kind: 'enter', messages: [...decision.messages, ...texts.map(toMessage)] };
		});
	}

	const preToolHooks = byEvent.get('tools/pre-execute') ?? [];
	if (preToolHooks.length > 0) {
		ctx.on('tools/pre-execute', async (exec, next) => {
			const payload = buildPayload(
				{
					event: 'tools/pre-execute',
					tool: exec.name,
					callId: exec.callId,
					toolArgs: JSON.stringify(exec.arguments ?? {}),
				},
				exec.agent,
			);
			const { denial } = await fireHooks(ctx, preToolHooks, payload, exec.signal, debug);
			if (denial !== undefined) return { kind: 'deny', reason: denial };
			return next();
		});
	}

	const postToolHooks = byEvent.get('tools/post-execute') ?? [];
	if (postToolHooks.length > 0) {
		ctx.on('tools/post-execute', async (exec, result, next) => {
			const payload = buildPayload(
				{
					event: 'tools/post-execute',
					tool: exec.name,
					callId: exec.callId,
					toolArgs: JSON.stringify(exec.arguments ?? {}),
					isError: result.isError === true,
					content: (result.content ?? [])
						.filter((block) => block?.type === 'text')
						.map((block) => block.text)
						.join('\n'),
				},
				exec.agent,
			);
			const { texts } = await fireHooks(ctx, postToolHooks, payload, exec.signal, debug);
			const downstream = await next();
			if (texts.length === 0) return downstream;
			const contexts = [...texts.map(toMessage), ...(downstream.additionalContexts ?? [])];
			return { ...downstream, additionalContexts: contexts };
		});
	}

	// The session stream is observe-only: these hooks fire and are not awaited by
	// the agent loop, so a slow webhook cannot stall a turn.
	const sessionHooks = [...byEvent.entries()].filter(([event]) => SESSION_EVENTS.has(event));
	if (sessionHooks.length > 0) {
		const sessionByEvent = new Map(sessionHooks);
		ctx.on('session/event', (session, event) => {
			const hooks = sessionByEvent.get(event.type);
			if (hooks === undefined) return;
			const payload = {
				timestamp: new Date().toISOString(),
				event: event.type,
				sessionId: session?.id ?? '',
				cwd: session?.cwd ?? '',
				turn: event.turn,
				step: event.step,
				tool: event.tool ?? event.name,
				reason: event.reason?.kind ?? '',
				content: typeof event.text === 'string' ? event.text : '',
			};
			void fireHooks(ctx, hooks, payload, AbortSignal.timeout(60_000), debug).catch((error) => {
				ctx.logger?.warn?.(`hookkit session/${event.type} hooks failed: ${String(error)}`);
			});
		});
	}
}

export {
	Config,
	abridge,
	apply,
	buildPayload,
	conversationTail,
	inject,
	lastAssistantText,
	lastUserText,
	messageText,
	name,
	sessionMessages,
};
