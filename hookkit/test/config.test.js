/** Pure-logic tests for hook compilation, filtering, and templating. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Config } from '../lib/config.js';
import { clip, compileHooks, matches, render, renderDeep } from '../lib/config.js';
import { abridge, conversationTail, lastUserText, reasonKind, sessionEventFields, sessionMessages } from '../lib/index.js';

/** Validate a raw hook list through the real schema, as the loader would. */
function compile(hooks) {
	return compileHooks(new Config({ hooks }));
}

const RECALL = {
	id: 'mem0-recall',
	on: 'agent/pre-step',
	when: { firstStep: true, hasUserMessage: true },
	do: { tool: 'mcp__mem0__search_memory', arguments: { query: '{{userText}}' } },
	inject: { as: 'context' },
};

describe('compileHooks', () => {
	it('groups enabled hooks by event and records the handler kind', () => {
		const byEvent = compile([RECALL]);
		assert.equal(byEvent.size, 1);
		assert.equal(byEvent.get('agent/pre-step')[0].kind, 'tool');
	});

	it('skips disabled hooks', () => {
		assert.equal(compile([{ ...RECALL, enabled: false }]).size, 0);
	});

	it('rejects a hook with no handler', () => {
		assert.throws(() => compile([{ ...RECALL, do: {} }]), /exactly one of do.tool/);
	});

	it('rejects a hook with two handlers', () => {
		assert.throws(
			() => compile([{ ...RECALL, do: { tool: 'x', run: 'echo hi' } }]),
			/exactly one of do.tool/,
		);
	});

	it('rejects deny on an event that cannot deny', () => {
		assert.throws(
			() => compile([{ ...RECALL, inject: { as: 'deny' } }]),
			/only "tools\/pre-execute" supports/,
		);
	});

	it('rejects context injection on an observe-only event', () => {
		assert.throws(
			() => compile([{ ...RECALL, on: 'turn/end', inject: { as: 'context' } }]),
			/inject.as: context/,
		);
	});

	it('rejects firstTurn on an event that cannot count turns', () => {
		assert.throws(
			() => compile([{ ...RECALL, on: 'tools/post-execute', when: { firstTurn: true } }]),
			/only "agent\/pre-step" can evaluate/,
		);
	});

	it('rejects duplicate ids', () => {
		assert.throws(() => compile([RECALL, { ...RECALL, on: 'turn/end', inject: { as: 'none' } }]), /duplicate hook id/);
	});
});

describe('matches', () => {
	const [hook] = compile([RECALL]).get('agent/pre-step');

	it('admits a first step carrying a user message', () => {
		assert.equal(matches(hook, { step: 1, hasUserMessage: true }), true);
	});

	it('rejects later steps when firstStep is set', () => {
		assert.equal(matches(hook, { step: 2, hasUserMessage: true }), false);
	});

	it('rejects a step with no user message when hasUserMessage is set', () => {
		assert.equal(matches(hook, { step: 1, hasUserMessage: false }), false);
	});

	it('admits only the first user turn when firstTurn is set', () => {
		const [primer] = compile([{ ...RECALL, when: { firstStep: true, firstTurn: true } }]).get('agent/pre-step');
		assert.equal(matches(primer, { step: 1, userTurn: 1 }), true);
		assert.equal(matches(primer, { step: 1, userTurn: 2 }), false);
	});

	it('rejects a payload with no turn count when firstTurn is set', () => {
		const [primer] = compile([{ ...RECALL, when: { firstTurn: true } }]).get('agent/pre-step');
		assert.equal(matches(primer, { step: 1 }), false);
	});

	it('ignores the turn count when firstTurn is not set', () => {
		assert.equal(matches(hook, { step: 1, hasUserMessage: true, userTurn: 9 }), true);
	});

	it('matches tool globs', () => {
		const [guard] = compile([
			{ id: 'g', on: 'tools/pre-execute', when: { tools: ['bash', 'mcp__*'] }, do: { run: 'x' }, inject: { as: 'deny' } },
		]).get('tools/pre-execute');
		assert.equal(matches(guard, { tool: 'bash' }), true);
		assert.equal(matches(guard, { tool: 'mcp__mem0__search_memory' }), true);
		assert.equal(matches(guard, { tool: 'edit' }), false);
	});

	it('treats a field absent from the payload as a non-match', () => {
		const [guard] = compile([
			{ id: 'g', on: 'tools/pre-execute', when: { match: { typo: '^x' } }, do: { run: 'x' }, inject: { as: 'deny' } },
		]).get('tools/pre-execute');
		assert.equal(matches(guard, { tool: 'bash' }), false);
	});

	it('filters turn/end by reason', () => {
		const [notify] = compile([
			{ id: 'n', on: 'turn/end', when: { reason: ['completed'] }, do: { run: 'x' } },
		]).get('turn/end');
		assert.equal(matches(notify, { reason: 'completed' }), true);
		assert.equal(matches(notify, { reason: 'aborted' }), false);
	});
});

describe('render', () => {
	it('substitutes known keys and blanks unknown ones', () => {
		assert.equal(render('a {{x}} b {{missing}}', { x: 'X' }), 'a X b ');
	});

	it('templates nested tool arguments', () => {
		assert.deepEqual(
			renderDeep({ query: '{{userText}}', limit: 5, tags: ['{{sessionId}}'] }, { userText: 'hi', sessionId: 's1' }),
			{ query: 'hi', limit: 5, tags: ['s1'] },
		);
	});
});

describe('clip', () => {
	it('leaves text within budget untouched', () => {
		assert.equal(clip('short', 10), 'short');
	});

	it('marks the cut when it truncates', () => {
		const out = clip('abcdefghij', 4);
		assert.ok(out.startsWith('abcd'));
		assert.match(out, /truncated at 4 chars/);
	});
});

describe('lastUserText', () => {
	const text = (t, kind) => ({ content: [{ type: 'text', text: t }], source: { kind } });

	it('reads the most recent user-authored message', () => {
		assert.equal(lastUserText([text('first', 'user'), text('second', 'user')]), 'second');
	});

	it('ignores plugin-authored notices, so injections cannot feed themselves', () => {
		assert.equal(lastUserText([text('real question', 'user'), text('<memories>…</memories>', 'plugin')]), 'real question');
	});

	it('returns empty when no user message is present', () => {
		assert.equal(lastUserText([text('model', 'model')]), '');
	});
});

describe('conversationTail', () => {
	const text = (t, kind) => ({ content: [{ type: 'text', text: t }], source: { kind } });

	it('pairs what the agent last said with what the user just replied', () => {
		const out = conversationTail([text('I patched mcp_server.py on dgx1.', 'model'), text('ok do it', 'user')]);
		assert.equal(out, 'ASSISTANT: I patched mcp_server.py on dgx1.\n\nUSER: ok do it');
	});

	it('abridges a long assistant message and marks the cut', () => {
		const long = `${'a'.repeat(700)}${'z'.repeat(400)}`;
		const out = conversationTail([text(long, 'model'), text('ok', 'user')], { assistantHead: 600, assistantTail: 300 });
		assert.ok(out.includes('[...]'));
		assert.ok(out.includes('a'.repeat(600)));
		assert.ok(out.includes('z'.repeat(300)));
		assert.ok(!out.includes('a'.repeat(601)));
	});

	it('ignores plugin notices and tool results, so a recall cannot feed itself', () => {
		const out = conversationTail([
			text('the real answer', 'model'),
			text('<memories>…</memories>', 'plugin'),
			text('{"results": []}', 'tool'),
			text('go on', 'user'),
		]);
		assert.equal(out, 'ASSISTANT: the real answer\n\nUSER: go on');
	});

	it('drops the assistant half when its budget is zero', () => {
		const messages = [text('context', 'model'), text('ok do it', 'user')];
		assert.equal(conversationTail(messages, { assistantHead: 0, assistantTail: 0 }), 'USER: ok do it');
	});

	it('renders only what exists', () => {
		assert.equal(conversationTail([text('first question', 'user')]), 'USER: first question');
		assert.equal(conversationTail([]), '');
	});

	it('defaults to the schema budgets', () => {
		assert.equal(new Config({}).conversationTail.assistantHead, 600);
		assert.equal(new Config({}).conversationTail.assistantTail, 300);
	});
});

describe('abridge', () => {
	it('leaves text that already fits untouched', () => {
		assert.equal(abridge('short', 600, 300), 'short');
	});

	it('keeps exactly the head and the tail', () => {
		assert.equal(abridge('abcdefghij', 2, 2), 'ab\n[...]\nij');
	});
});

describe('sessionMessages', () => {
	const msg = (id, kind) => ({ id, content: [{ type: 'text', text: id }], source: { kind } });

	it('appends claimed messages the session has not projected yet', () => {
		const agent = { session: { deriveMessages: () => [msg('m1', 'model')] } };
		assert.deepEqual(
			sessionMessages(agent, [msg('u2', 'user')]).map((m) => m.id),
			['m1', 'u2'],
		);
	});

	it('does not duplicate a claimed message already in the history', () => {
		const agent = { session: { deriveMessages: () => [msg('m1', 'model'), msg('u2', 'user')] } };
		assert.deepEqual(
			sessionMessages(agent, [msg('u2', 'user')]).map((m) => m.id),
			['m1', 'u2'],
		);
	});

	it('falls back to the claimed messages when the session cannot answer', () => {
		const thrower = { session: { deriveMessages: () => { throw new Error('no surface'); } } };
		assert.deepEqual(sessionMessages(thrower, [msg('u1', 'user')]).map((m) => m.id), ['u1']);
		assert.deepEqual(sessionMessages(undefined, [msg('u1', 'user')]).map((m) => m.id), ['u1']);
	});
});

describe('sessionEventFields', () => {
	// Session events are `{ type, seq, time, data }`. Reading the envelope
	// instead of `data` left every one of these fields empty, which silently
	// turned `when: { reason: [...] }` into a filter nothing could satisfy.
	it('reads turn and reason out of a turn/end event', () => {
		const fields = sessionEventFields({ type: 'turn/end', seq: 9, data: { turn: 3, reason: { kind: 'error', error: {} } } });
		assert.equal(fields.turn, 3);
		assert.equal(fields.reason, 'error');
	});

	it('matches a reason filter that the envelope read could never satisfy', () => {
		const [notify] = compile([{ id: 'n', on: 'turn/end', when: { reason: ['error'] }, do: { http: 'http://x' } }]).get('turn/end');
		assert.equal(matches(notify, sessionEventFields({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })), true);
		assert.equal(matches(notify, sessionEventFields({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })), false);
	});

	// `summary` is typed `ContentBlock[]`, not a string — reading it as one is
	// how the mem0 persist hook came to write the empty string every time.
	it('carries the compaction summary as {{content}}', () => {
		const fields = sessionEventFields({
			type: 'compaction/summary',
			data: {
				compactionId: 'c-1',
				summary: [{ type: 'text', text: 'the user prefers pnpm' }],
				shadowedTokenCount: 40_000,
			},
		});
		assert.equal(fields.content, 'the user prefers pnpm');
		assert.equal(fields.compactionId, 'c-1');
	});

	// A ToolResultMessage's content is a single `tool-result` block whose own
	// `content` holds the text, so the message-level read finds nothing.
	it('unwraps the tool-result block a tool/result message wraps its text in', () => {
		const fields = sessionEventFields({
			type: 'tool/result',
			data: {
				turn: 1,
				step: 2,
				message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'exit 0' }] }] },
			},
		});
		assert.equal(fields.content, 'exit 0');
	});

	// `tool/call` types `arguments` as an already-encoded JSON string; encoding
	// it again would hand the hook a quoted blob to unwrap twice.
	it('passes an already-encoded arguments string through unchanged', () => {
		const encoded = '{"command":"ls -la"}';
		assert.equal(sessionEventFields({ type: 'tool/call', data: { name: 'bash', arguments: encoded } }).toolArgs, encoded);
	});

	it('names the tool whichever key the event spells it with', () => {
		assert.equal(sessionEventFields({ type: 'tool/call', data: { name: 'bash', callId: 'c1' } }).tool, 'bash');
		assert.equal(sessionEventFields({ type: 'approval/asked', data: { toolName: 'edit' } }).tool, 'edit');
	});

	it('unwraps the message a user/message event carries', () => {
		const data = { role: 'user', content: [{ type: 'text', text: 'ok do it' }] };
		assert.equal(sessionEventFields({ type: 'user/message', data }).content, 'ok do it');
	});

	// An absent field has to stay absent: `matches` rejects a non-string, so a
	// filter naming a field this event does not carry fails closed.
	it('leaves fields the event does not carry undefined', () => {
		const fields = sessionEventFields({ type: 'compaction/start', data: { compactionId: 'c-1', turn: 2 } });
		assert.equal(fields.tool, undefined);
		assert.equal(fields.toolArgs, undefined);
		assert.equal(fields.content, '');
	});
});

describe('reasonKind', () => {
	it('accepts both shapes the harness emits', () => {
		assert.equal(reasonKind({ kind: 'completed' }), 'completed');
		assert.equal(reasonKind('user asked'), 'user asked');
		assert.equal(reasonKind(undefined), '');
	});
});
