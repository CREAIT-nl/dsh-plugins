/**
 * The three hook handler kinds, normalized to one contract:
 * every handler resolves to `{ ok, output, detail }` and never throws.
 *
 * `ok` drives the deny decision (a `false` from a `tools/pre-execute` hook
 * blocks the call); `output` is the text a `context` injection carries; `detail`
 * is diagnostic-only and never reaches the model.
 *
 * @module @creait/dsh-hookkit/handlers
 */

import { CallId } from '@deepseek-ai/dsh-llm';

import { renderDeep } from './config.js';

/** Monotonic suffix so concurrent hook tool calls never collide on a call id. */
let callSequence = 0;

/**
 * Flatten a tool result's content blocks into plain text.
 *
 * MCP tools answer with a `text` block holding a JSON document (mem0 returns
 * `{"result": "{\"results\": [...]}"}`), so a caller that wants the payload
 * wants the concatenated text, not the block structure.
 *
 * @param result - a settled `ToolExecutionResult`.
 * @returns the concatenated text of every text block, trimmed.
 */
function textOf(result) {
	const blocks = Array.isArray(result?.content) ? result.content : [];
	return blocks
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n')
		.trim();
}

/**
 * Invoke an in-harness registered tool — the path that keeps mem0 on MCP.
 *
 * The tool runs through the same pipeline a model-issued call would, so guards,
 * approval policy, and `tools/result` observers all still apply. That is
 * deliberate: a hook is a privileged *caller*, not a way around the policy tree.
 *
 * @param ctx - the plugin context (needs the `tools` service).
 * @param hook - the compiled hook.
 * @param payload - the flattened event payload used to template arguments.
 * @param signal - cancellation for this invocation.
 * @returns the normalized handler outcome.
 */
async function runToolHandler(ctx, hook, payload, signal) {
	const name = hook.do.tool;
	if (ctx.tools === undefined) {
		return { ok: false, output: '', detail: 'tools service unavailable' };
	}
	const args = renderDeep(hook.do.arguments, payload);
	callSequence += 1;
	try {
		const result = await ctx.tools.execute({
			callId: CallId(`hookkit:${hook.id}:${callSequence}`),
			name,
			arguments: args,
			agent: payload.__agent,
			signal,
		});
		if (result.isError) {
			return { ok: false, output: '', detail: `${name} failed: ${result.error?.message ?? 'unknown error'}` };
		}
		return { ok: true, output: textOf(result), detail: `${name} ok` };
	} catch (error) {
		return { ok: false, output: '', detail: `${name} threw: ${String(error)}` };
	}
}

/**
 * Run a shell command with the payload as JSON on stdin.
 *
 * Exit code 0 means allow, non-zero means deny — the Claude Code hook contract,
 * so an existing `.claude` hook script works here unmodified.
 *
 * @param ctx - the plugin context (needs the `shell` service).
 * @param hook - the compiled hook.
 * @param payload - the flattened event payload.
 * @param signal - cancellation for this invocation.
 * @returns the normalized handler outcome; stdout is the injectable output.
 */
async function runShellHandler(ctx, hook, payload, signal) {
	if (ctx.shell === undefined) {
		return { ok: false, output: '', detail: 'shell service unavailable' };
	}
	const command = hook.do.run;
	const wire = JSON.stringify(publicPayload(payload));
	try {
		const spec = ctx.shell.resolve({
			command,
			workdir: typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : undefined,
			timeoutMs: hook.timeoutMs,
			signal,
			stdin: wire,
			env: shellEnv(hook, payload),
		});
		const result = await ctx.shell.run(spec);
		const stdout = result.stdout?.text?.trim() ?? '';
		const stderr = result.stderr?.text?.trim() ?? '';
		if (result.timedOut) return { ok: false, output: stdout, detail: `timed out after ${result.timeoutMs}ms` };
		if (result.aborted) return { ok: false, output: stdout, detail: 'aborted' };
		const ok = result.exitCode === 0;
		return { ok, output: stdout, detail: ok ? 'exit 0' : `exit ${result.exitCode}${stderr.length > 0 ? `: ${stderr.slice(0, 400)}` : ''}` };
	} catch (error) {
		return { ok: false, output: '', detail: `shell threw: ${String(error)}` };
	}
}

/**
 * POST the payload as JSON to an endpoint; a 2xx is allow, anything else deny.
 * @param hook - the compiled hook.
 * @param payload - the flattened event payload.
 * @param signal - cancellation for this invocation.
 * @returns the normalized handler outcome; the response body is the output.
 */
async function runHttpHandler(hook, payload, signal) {
	const url = hook.do.http;
	const timer = AbortSignal.timeout(hook.timeoutMs);
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(publicPayload(payload)),
			signal: AbortSignal.any([signal, timer]),
		});
		const body = (await response.text()).trim();
		return {
			ok: response.ok,
			output: body,
			detail: `${response.status} ${response.statusText}`,
		};
	} catch (error) {
		return { ok: false, output: '', detail: `http threw: ${String(error)}` };
	}
}

/**
 * Environment for a shell hook. `CLAUDE_PROJECT_DIR` is spelled that way on
 * purpose: it is what ported Claude Code hook scripts read.
 * @param hook - the compiled hook.
 * @param payload - the flattened event payload.
 * @returns the ordinary environment entries for the command.
 */
function shellEnv(hook, payload) {
	const env = {
		DSH_HOOK_ID: hook.id,
		DSH_HOOK_EVENT: hook.on,
	};
	for (const [key, value] of Object.entries(publicPayload(payload))) {
		if (value === undefined || value === null) continue;
		env[`DSH_HOOK_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`] =
			typeof value === 'string' ? value : JSON.stringify(value);
	}
	if (typeof payload.cwd === 'string') env.CLAUDE_PROJECT_DIR = payload.cwd;
	return env;
}

/**
 * Strip engine-internal keys (the live `Agent` handle) before a payload crosses
 * a process or network boundary.
 * @param payload - the flattened event payload.
 * @returns a JSON-serializable copy.
 */
function publicPayload(payload) {
	return Object.fromEntries(Object.entries(payload).filter(([key]) => !key.startsWith('__')));
}

/**
 * Dispatch to the handler kind this hook declared.
 * @param ctx - the plugin context.
 * @param hook - the compiled hook.
 * @param payload - the flattened event payload.
 * @param signal - cancellation for this invocation.
 * @returns the normalized `{ ok, output, detail }` outcome; never rejects.
 */
async function runHandler(ctx, hook, payload, signal) {
	if (hook.kind === 'tool') return runToolHandler(ctx, hook, payload, signal);
	if (hook.kind === 'run') return runShellHandler(ctx, hook, payload, signal);
	return runHttpHandler(hook, payload, signal);
}

export { publicPayload, runHandler, runHttpHandler, runShellHandler, runToolHandler, shellEnv, textOf };
