/**
 * Wiring tests: drive `apply` against a stub Cordis context and assert the
 * decisions the real waterfalls would see. Covers the capability the market
 * plugins lack — a hook contributing model-visible context.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Config, apply, name } from '../lib/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const manifest = JSON.parse(read('package.json'));

describe('the package manifest', () => {
	it('ships every file it lists', () => {
		for (const file of manifest.files) assert.ok(existsSync(join(ROOT, file)), `listed but missing: ${file}`);
	});

	// Without this the package installs and mounts nothing: `dsh plugin add`
	// records the dependency, and only a `dsh.bundle` manifest field makes the
	// profile apply the patch that inserts the row.
	it('points the harness at its bundle patch, and publishes it', () => {
		assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
		assert.ok(manifest.files.includes('cordis.patch.yml'), 'the patch would not be published');
	});

	it('is named as the row the bundle patch inserts', () => {
		const patch = read('cordis.patch.yml');
		assert.match(patch, new RegExp(`name: '${manifest.name.replace('/', '\\/')}'`));
		assert.match(patch, /id: hookkit/);
		assert.equal(name, 'hookkit');
	});

	// The bundle mounts this row for anyone who installs the package, so an
	// undeclared engine has to be free. `apply` returning before it registers a
	// listener is what makes that true, and the empty default is what gets it
	// there.
	it('costs nothing when the bundle mounts it undeclared', () => {
		const ctx = stubContext();
		apply(ctx, new Config({}));
		assert.deepEqual(new Config({}).hooks, []);
		assert.equal(ctx.listeners.size, 0);
	});
});

/** A minimal Cordis-shaped context recording its listeners. */
function stubContext({ toolResult, shellResult } = {}) {
	const listeners = new Map();
	const calls = [];
	return {
		calls,
		listeners,
		on(event, handler) {
			listeners.set(event, handler);
		},
		logger: { info() {}, warn() {} },
		tools: {
			async execute(exec) {
				calls.push(exec);
				return (
					toolResult ?? {
						isError: false,
						value: null,
						content: [{ type: 'text', text: 'memory: prefers pnpm' }],
					}
				);
			},
		},
		shell: {
			resolve: (request) => request,
			async run(spec) {
				calls.push(spec);
				return (
					shellResult ?? {
						exitCode: 0,
						signal: null,
						timedOut: false,
						aborted: false,
						timeoutMs: 1000,
						stdout: { text: 'from shell', truncated: false },
						stderr: { text: '', truncated: false },
					}
				);
			},
		},
	};
}

const userMessage = (text) => ({ content: [{ type: 'text', text }], source: { kind: 'user' } });

const AGENT = { session: { id: 'sess-1', cwd: '/repo' } };

describe('agent/pre-step context injection', () => {
	const recall = {
		id: 'mem0-recall',
		on: 'agent/pre-step',
		when: { firstStep: true, hasUserMessage: true },
		do: { tool: 'mcp__mem0__search_memory', arguments: { query: '{{userText}}' } },
		inject: { as: 'context', template: '<memories>\n{{output}}\n</memories>', summary: 'mem0' },
	};

	it('calls the tool with the templated query and appends the rendered context', async () => {
		const ctx = stubContext();
		apply(ctx, new Config({ hooks: [recall] }));
		const messages = [userMessage('how do I install deps?')];
		const decision = await listener(ctx, 'agent/pre-step')(
			{ agent: AGENT, messages, step: 1, signal: AbortSignal.timeout(5000) },
			async () => ({ kind: 'enter', messages }),
		);

		assert.equal(ctx.calls.length, 1);
		assert.equal(ctx.calls[0].name, 'mcp__mem0__search_memory');
		assert.deepEqual(ctx.calls[0].arguments, { query: 'how do I install deps?' });

		assert.equal(decision.messages.length, 2);
		const injected = decision.messages[1];
		assert.equal(injected.content[0].text, '<memories>\nmemory: prefers pnpm\n</memories>');
		assert.equal(injected.source.kind, 'plugin');
		assert.equal(injected.source.summary, 'mem0');
	});

	it('templates {{conversationTail}} from the session history, not just the claimed messages', async () => {
		const ctx = stubContext();
		apply(ctx, new Config({ hooks: [{ ...recall, do: { ...recall.do, arguments: { query: '{{conversationTail}}' } } }] }));
		const messages = [userMessage('ok do it')];
		const agent = {
			session: {
				id: 'sess-1',
				cwd: '/repo',
				deriveMessages: () => [
					{ id: 'm1', content: [{ type: 'text', text: 'I can patch mcp_server.py on dgx1.' }], source: { kind: 'model' } },
				],
			},
		};
		await listener(ctx, 'agent/pre-step')(
			{ agent, messages, step: 1, signal: AbortSignal.timeout(5000) },
			async () => ({ kind: 'enter', messages }),
		);

		assert.deepEqual(ctx.calls[0].arguments, {
			query: 'ASSISTANT: I can patch mcp_server.py on dgx1.\n\nUSER: ok do it',
		});
	});

	it('fires on the session\'s first user turn and not on the second, when firstTurn is set', async () => {
		const primer = { ...recall, when: { firstStep: true, firstTurn: true } };
		const turn = async (history) => {
			const ctx = stubContext();
			apply(ctx, new Config({ hooks: [primer] }));
			const messages = [userMessage('ok do it')];
			const agent = { session: { id: 'sess-1', cwd: '/repo', deriveMessages: () => history } };
			await listener(ctx, 'agent/pre-step')(
				{ agent, messages, step: 1, signal: AbortSignal.timeout(5000) },
				async () => ({ kind: 'enter', messages }),
			);
			return ctx.calls.length;
		};

		// Turn one: the claimed message is the only user-authored message there is.
		assert.equal(await turn([]), 1);

		// Turn two: an earlier user message is already in the derived history.
		assert.equal(
			await turn([
				{ id: 'm1', content: [{ type: 'text', text: 'how do I install deps?' }], source: { kind: 'user' } },
				{ id: 'm2', content: [{ type: 'text', text: 'pnpm install.' }], source: { kind: 'model' } },
			]),
			0,
		);
	});

	it('does not count its own injections as user turns', async () => {
		const ctx = stubContext();
		apply(ctx, new Config({ hooks: [{ ...recall, when: { firstStep: true, firstTurn: true } }] }));
		const messages = [userMessage('what did we decide?')];
		const agent = {
			session: {
				id: 'sess-1',
				cwd: '/repo',
				deriveMessages: () => [
					{ id: 'm1', content: [{ type: 'text', text: '<memories>…</memories>' }], source: { kind: 'plugin' } },
				],
			},
		};
		await listener(ctx, 'agent/pre-step')(
			{ agent, messages, step: 1, signal: AbortSignal.timeout(5000) },
			async () => ({ kind: 'enter', messages }),
		);
		assert.equal(ctx.calls.length, 1);
	});

	it('does not fire on step 2, so recall costs one call per turn', async () => {
		const ctx = stubContext();
		apply(ctx, new Config({ hooks: [recall] }));
		const messages = [userMessage('q')];
		const decision = await listener(ctx, 'agent/pre-step')(
			{ agent: AGENT, messages, step: 2, signal: AbortSignal.timeout(5000) },
			async () => ({ kind: 'enter', messages }),
		);
		assert.equal(ctx.calls.length, 0);
		assert.equal(decision.messages.length, 1);
	});

	it('injects nothing when the tool returns empty and skipIfEmpty holds', async () => {
		const ctx = stubContext({ toolResult: { isError: false, value: null, content: [{ type: 'text', text: '   ' }] } });
		apply(ctx, new Config({ hooks: [recall] }));
		const messages = [userMessage('q')];
		const decision = await listener(ctx, 'agent/pre-step')(
			{ agent: AGENT, messages, step: 1, signal: AbortSignal.timeout(5000) },
			async () => ({ kind: 'enter', messages }),
		);
		assert.equal(decision.messages.length, 1);
	});

	it('fails open: a tool error leaves the turn untouched', async () => {
		const ctx = stubContext({
			toolResult: { isError: true, error: { message: 'mem0 unreachable' }, content: [] },
		});
		apply(ctx, new Config({ hooks: [recall] }));
		const messages = [userMessage('q')];
		const decision = await listener(ctx, 'agent/pre-step')(
			{ agent: AGENT, messages, step: 1, signal: AbortSignal.timeout(5000) },
			async () => ({ kind: 'enter', messages }),
		);
		assert.equal(decision.messages.length, 1);
		assert.equal(decision.kind, 'enter');
	});

	it('leaves a rejected step alone', async () => {
		const ctx = stubContext();
		apply(ctx, new Config({ hooks: [recall] }));
		const decision = await listener(ctx, 'agent/pre-step')(
			{ agent: AGENT, messages: [userMessage('q')], step: 1, signal: AbortSignal.timeout(5000) },
			async () => ({ kind: 'reject' }),
		);
		assert.equal(decision.kind, 'reject');
		assert.equal(ctx.calls.length, 0);
	});
});

describe('tools/pre-execute deny', () => {
	const guard = {
		id: 'block-rm',
		on: 'tools/pre-execute',
		when: { tools: ['bash'] },
		do: { run: 'node guard.mjs' },
		inject: { as: 'deny' },
	};

	it('denies with the handler stdout when the command exits non-zero', async () => {
		const ctx = stubContext({
			shellResult: {
				exitCode: 2,
				signal: null,
				timedOut: false,
				aborted: false,
				timeoutMs: 1000,
				stdout: { text: 'refusing: rm -rf on a tracked path', truncated: false },
				stderr: { text: '', truncated: false },
			},
		});
		apply(ctx, new Config({ hooks: [guard] }));
		const decision = await listener(ctx, 'tools/pre-execute')(
			{ name: 'bash', callId: 'c1', arguments: { command: 'rm -rf /' }, agent: AGENT, signal: AbortSignal.timeout(5000) },
			async () => ({ kind: 'allow' }),
		);
		assert.deepEqual(decision, { kind: 'deny', reason: 'refusing: rm -rf on a tracked path' });
	});

	it('allows through when the command exits zero', async () => {
		const ctx = stubContext();
		apply(ctx, new Config({ hooks: [guard] }));
		const decision = await listener(ctx, 'tools/pre-execute')(
			{ name: 'bash', callId: 'c1', arguments: {}, agent: AGENT, signal: AbortSignal.timeout(5000) },
			async () => ({ kind: 'allow' }),
		);
		assert.deepEqual(decision, { kind: 'allow' });
	});

	it('ignores tools outside its glob', async () => {
		const ctx = stubContext();
		apply(ctx, new Config({ hooks: [guard] }));
		await listener(ctx, 'tools/pre-execute')(
			{ name: 'edit', callId: 'c1', arguments: {}, agent: AGENT, signal: AbortSignal.timeout(5000) },
			async () => ({ kind: 'allow' }),
		);
		assert.equal(ctx.calls.length, 0);
	});

	it('passes the payload to the command on stdin', async () => {
		const ctx = stubContext();
		apply(ctx, new Config({ hooks: [guard] }));
		await listener(ctx, 'tools/pre-execute')(
			{ name: 'bash', callId: 'c9', arguments: { command: 'ls' }, agent: AGENT, signal: AbortSignal.timeout(5000) },
			async () => ({ kind: 'allow' }),
		);
		const payload = JSON.parse(ctx.calls[0].stdin);
		assert.equal(payload.tool, 'bash');
		assert.equal(payload.callId, 'c9');
		assert.equal(payload.sessionId, 'sess-1');
		assert.equal(payload.__agent, undefined, 'the live Agent handle must not cross the process boundary');
		assert.equal(ctx.calls[0].env.CLAUDE_PROJECT_DIR, '/repo');
		assert.equal(ctx.calls[0].env.DSH_HOOK_ID, 'block-rm');
	});
});

describe('tools/post-execute context', () => {
	it('prepends its context ahead of downstream contributions', async () => {
		const ctx = stubContext();
		apply(
			ctx,
			new Config({
				hooks: [
					{ id: 'after-edit', on: 'tools/post-execute', when: { tools: ['edit'] }, do: { run: 'x' }, inject: { as: 'context' } },
				],
			}),
		);
		const theirs = { content: [{ type: 'text', text: 'downstream' }], source: { kind: 'plugin' } };
		const decision = await listener(ctx, 'tools/post-execute')(
			{ name: 'edit', callId: 'c1', arguments: {}, agent: AGENT, signal: AbortSignal.timeout(5000) },
			{ isError: false, content: [] },
			async () => ({ kind: 'accept', additionalContexts: [theirs] }),
		);
		assert.equal(decision.additionalContexts.length, 2);
		assert.equal(decision.additionalContexts[0].content[0].text, 'from shell');
		assert.equal(decision.additionalContexts[1], theirs);
	});
});

describe('listener registration', () => {
	it('registers only the events that have hooks', () => {
		const ctx = stubContext();
		apply(ctx, new Config({ hooks: [{ id: 'n', on: 'turn/end', do: { run: 'x' } }] }));
		assert.deepEqual([...ctx.listeners.keys()], ['session/event']);
	});

	it('registers nothing at all when no hooks are declared', () => {
		const ctx = stubContext();
		apply(ctx, new Config({ hooks: [] }));
		assert.equal(ctx.listeners.size, 0);
	});
});

/** Fetch the handler registered for one event, failing loudly when absent. */
function listener(ctx, event) {
	const handler = ctx.listeners.get(event);
	assert.ok(handler, `no listener registered for ${event}`);
	return handler;
}
