/**
 * The research loop's control flow.
 *
 * Four of these tests exist because the loop this one is ported from gets them
 * wrong, and each failure is invisible from the outside — the report still
 * arrives, still reads well, and is quietly less than it claims. They are named
 * after the flaw they pin down.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { argsFor, planWith, questionOf, runLoop } from './harness.js';

/** Every researcher assignment the run actually made, in order. */
function researched(calls) {
	return calls.filter((call) => call.opts.phase === 'Research').map((call) => questionOf(call.prompt));
}

describe('the research loop', () => {
	it('researches the plan and reports what it covered', async () => {
		const { result } = await runLoop({
			args: argsFor({ rounds: 2, width: 3 }),
			plan: planWith(5),
			research: () => ({
				confirmed: [{ claim: 'c', source: 'https://example.test/a', confidence: 'high' }],
				uncertain: [{ point: 'u', reason: 'r' }],
				gaps: [],
			}),
		});

		assert.equal(result.coverage.planned, 5);
		assert.equal(result.coverage.researched, 5);
		assert.deepEqual(result.coverage.deferred, []);
		assert.deepEqual(result.coverage.failed, []);
		assert.equal(result.coverage.rounds, 2);
		assert.equal(result.coverage.claims, 5);
		assert.equal(result.coverage.uncertainties, 5);
		assert.deepEqual(result.sources, ['https://example.test/a']);
		assert.equal(result.scope, 'the scope');
	});

	// FLAW 1. Upstream, questions still queued when the round cap hit were
	// dropped on the floor: not researched, not counted, not mentioned. The
	// report then described five questions' worth of research as the answer to
	// ten questions, and nothing in it said otherwise.
	it('names every question the budget never reached, instead of dropping it', async () => {
		const { result, logs } = await runLoop({
			args: argsFor({ rounds: 2, width: 3 }),
			plan: planWith(10),
			research: () => ({ confirmed: [] }),
		});

		assert.equal(result.coverage.planned, 10);
		assert.equal(result.coverage.researched, 6);
		assert.deepEqual(result.coverage.deferred, ['q7', 'q8', 'q9', 'q10']);
		assert.ok(logs.some((line) => line.includes('budget exhausted')));
	});

	it('tells the planner its budget, so it does not plan past it', async () => {
		const { calls } = await runLoop({
			args: argsFor({ rounds: 3, width: 4 }),
			plan: planWith(2),
			research: () => ({ confirmed: [] }),
		});

		const planner = calls[0].prompt;
		assert.match(planner, /At most 12 sub-questions will ever be researched/);
		assert.match(planner, /4 researchers per round, 3 rounds/);
		assert.match(planner, /reported to the reader as DEFERRED/);
	});

	// FLAW 2. Upstream capped harvested leads at the round width and discarded
	// the rest, so a round in which every researcher found something urgent lost
	// most of it — silently, with no record that a lead had ever existed.
	it('queues every high-priority lead rather than capping them at the round width', async () => {
		const { result, calls } = await runLoop({
			args: argsFor({ rounds: 3, width: 2 }),
			plan: planWith(2),
			research: (question) =>
				question === 'q1' || question === 'q2'
					? {
							confirmed: [],
							gaps: [
								{ aspect: `${question}-lead-a`, priority: 'high' },
								{ aspect: `${question}-lead-b`, priority: 'high' },
								{ aspect: `${question}-lead-c`, priority: 'high' },
							],
						}
					: { confirmed: [] },
		});

		// Six leads from a two-wide round: upstream kept two and lost four.
		assert.equal(result.coverage.followUps, 6);

		const seen = new Set([...researched(calls), ...result.coverage.deferred]);
		for (const parent of ['q1', 'q2']) {
			for (const suffix of ['a', 'b', 'c']) {
				assert.ok(seen.has(`${parent}-lead-${suffix}`), `${parent}-lead-${suffix} was lost`);
			}
		}
		assert.equal(result.coverage.researched + result.coverage.deferred.length, 8);
	});

	// FLAW 3. Upstream rebuilt its `seen` set inside the round loop, so a gap
	// reported by researchers in three consecutive rounds was assigned three
	// times — spending the budget re-answering a question it already had.
	it('researches a repeatedly-reported gap once, not once per round', async () => {
		const { calls, result } = await runLoop({
			args: argsFor({ rounds: 4, width: 2 }),
			plan: planWith(4),
			research: () => ({ confirmed: [], gaps: [{ aspect: 'the same nagging gap', priority: 'high' }] }),
		});

		const assignments = researched(calls).filter((question) => question === 'the same nagging gap');
		assert.equal(assignments.length, 1);
		assert.equal(result.coverage.followUps, 1);
	});

	it('does not re-queue a lead that restates a planned question', async () => {
		const { calls } = await runLoop({
			args: argsFor({ rounds: 3, width: 2 }),
			plan: planWith(2),
			research: () => ({ confirmed: [], gaps: [{ aspect: 'Q1.', priority: 'high' }] }),
		});

		assert.deepEqual(researched(calls), ['q1', 'q2']);
	});

	it('leaves medium and low leads unpursued but counted', async () => {
		const { result, calls } = await runLoop({
			args: argsFor({ rounds: 3, width: 2 }),
			plan: planWith(2),
			research: () => ({
				confirmed: [],
				gaps: [
					{ aspect: 'a maybe', priority: 'medium' },
					{ aspect: 'a shrug', priority: 'low' },
				],
			}),
		});

		assert.deepEqual(researched(calls), ['q1', 'q2']);
		assert.equal(result.coverage.followUps, 0);
		assert.equal(result.coverage.openLeads, 2);
	});

	// FLAW 4. Upstream skipped planning entirely when questions were supplied,
	// so the run had no scope, no dimensions and no coverage audit — and the
	// synthesis stage had nothing to organise the report around.
	it('still plans when the caller supplies its own questions', async () => {
		const supplied = ['does it scale?', 'what does it cost?'];
		const { calls, result } = await runLoop({
			args: argsFor({ questions: supplied, rounds: 2, width: 3 }),
			plan: planWith(0, {
				questions: supplied.map((question) => ({ question, dimension: 'd1' })),
				scope: 'audited scope',
				coverage_gaps: ['nobody asked about licensing'],
			}),
			research: () => ({ confirmed: [] }),
		});

		const planner = calls[0].prompt;
		assert.match(planner, /QUESTIONS THE CALLER REQUIRES/);
		assert.match(planner, /VERBATIM/);
		for (const question of supplied) assert.ok(planner.includes(question));

		assert.deepEqual(researched(calls), supplied);
		assert.equal(result.scope, 'audited scope');
	});

	it('carries breadth before depth: follow-ups queue behind the plan', async () => {
		const { calls } = await runLoop({
			args: argsFor({ rounds: 3, width: 2 }),
			plan: planWith(4),
			research: (question) =>
				question === 'q1' ? { confirmed: [], gaps: [{ aspect: 'a lead', priority: 'high' }] } : { confirmed: [] },
		});

		assert.deepEqual(researched(calls), ['q1', 'q2', 'q3', 'q4', 'a lead']);
	});

	it('marks a follow-up as one, and tells the researcher where it came from', async () => {
		const { calls } = await runLoop({
			args: argsFor({ rounds: 2, width: 1 }),
			plan: planWith(1),
			research: (question) =>
				question === 'q1' ? { confirmed: [], gaps: [{ aspect: 'the lead', priority: 'high' }] } : { confirmed: [] },
		});

		const followUp = calls.find((call) => questionOf(call.prompt) === 'the lead');
		assert.match(followUp.prompt, /This is a FOLLOW-UP/);
		assert.match(followUp.prompt, /round 1 as an unclosed gap in "q1"/);
	});
});

describe('failure handling', () => {
	it('reports a failed researcher as unanswered and keeps going', async () => {
		const { result } = await runLoop({
			args: argsFor({ rounds: 1, width: 3 }),
			plan: planWith(3),
			research: (question) => (question === 'q2' ? null : { confirmed: [] }),
		});

		assert.deepEqual(result.coverage.failed, ['q2']);
		assert.equal(result.coverage.researched, 2);
	});

	it('refuses to write a report when every researcher failed', async () => {
		await assert.rejects(
			runLoop({ args: argsFor(), plan: planWith(3), research: () => null }),
			/no evidence to write from/,
		);
	});

	it('refuses to start when the planner fails', async () => {
		await assert.rejects(runLoop({ args: argsFor(), plan: null }), /planner failed/);
	});

	it('refuses to start when the planner returns no usable questions', async () => {
		await assert.rejects(
			runLoop({ args: argsFor(), plan: planWith(0, { questions: [{ question: '  ' }] }) }),
			/no researchable questions/,
		);
	});

	it('refuses to return when synthesis fails', async () => {
		await assert.rejects(
			runLoop({ args: argsFor(), plan: planWith(1), research: () => ({ confirmed: [] }), synthesis: null }),
			/synthesis failed/,
		);
	});
});

describe('the synthesis contract', () => {
	it('hands the writer the evidence, the coverage and the deferred questions by name', async () => {
		const { calls } = await runLoop({
			args: argsFor({ rounds: 1, width: 2, audience: 'a platform engineer' }),
			plan: planWith(4),
			research: () => ({ confirmed: [{ claim: 'the claim', source: 'https://example.test/a' }] }),
		});

		const synthesis = calls.find((call) => call.opts.label === 'synthesise').prompt;
		assert.match(synthesis, /Researched 2 question\(s\)/);
		assert.match(synthesis, /NEVER ANSWERED \(2\)/);
		assert.ok(synthesis.includes('- q3'));
		assert.ok(synthesis.includes('- q4'));
		assert.ok(synthesis.includes('"claim": "the claim"'));
		assert.match(synthesis, /AUDIENCE: a platform engineer/);
		assert.match(synthesis, /What this report does not cover/);
	});

	it('says so plainly when nothing was left unanswered', async () => {
		const { calls } = await runLoop({
			args: argsFor({ rounds: 2, width: 3 }),
			plan: planWith(2),
			research: () => ({ confirmed: [] }),
		});

		const synthesis = calls.find((call) => call.opts.label === 'synthesise').prompt;
		assert.match(synthesis, /Every planned and follow-up question was researched/);
		assert.doesNotMatch(synthesis, /NEVER ANSWERED/);
	});
});

describe('the review pass', () => {
	it('is skipped when it is off', async () => {
		const { calls, result } = await runLoop({
			args: argsFor({ review: false }),
			plan: planWith(1),
			research: () => ({ confirmed: [] }),
		});

		assert.equal(calls.some((call) => call.opts.phase === 'Review'), false);
		assert.equal(result.coverage.reviewed, false);
	});

	it('reviews the report against its own evidence, then returns the revision', async () => {
		const { calls, result } = await runLoop({
			args: argsFor({ review: true }),
			plan: planWith(1),
			research: () => ({ confirmed: [{ claim: 'the claim', source: 'https://example.test/a' }] }),
			synthesis: '# Draft',
			review: '1. [2] cites a source that is not in the evidence.',
			revision: '# Final',
		});

		const critic = calls.find((call) => call.opts.label === 'review').prompt;
		assert.match(critic, /FABRICATION/);
		assert.ok(critic.includes('"claim": "the claim"'));
		assert.ok(critic.includes('# Draft'));

		const reviser = calls.find((call) => call.opts.label === 'revise').prompt;
		assert.ok(reviser.includes('cites a source that is not in the evidence'));
		assert.match(reviser, /never to source it after the fact/);

		assert.equal(result.report, '# Final');
		assert.equal(result.coverage.reviewed, true);
	});

	it('keeps the unreviewed report when the reviewer fails', async () => {
		const { result, logs } = await runLoop({
			args: argsFor({ review: true }),
			plan: planWith(1),
			research: () => ({ confirmed: [] }),
			synthesis: '# Draft',
			review: null,
		});

		assert.equal(result.report, '# Draft');
		assert.equal(result.coverage.reviewed, false);
		assert.ok(logs.some((line) => line.includes('reviewer failed')));
	});

	it('keeps the draft when the revision fails', async () => {
		const { result } = await runLoop({
			args: argsFor({ review: true }),
			plan: planWith(1),
			research: () => ({ confirmed: [] }),
			synthesis: '# Draft',
			review: 'one defect',
			revision: null,
		});

		assert.equal(result.report, '# Draft');
	});
});

describe('progress reporting', () => {
	it('groups every agent under a phase declared in the workflow meta', async () => {
		const { calls, phases } = await runLoop({
			args: argsFor({ review: true, rounds: 1, width: 1 }),
			plan: planWith(1),
			research: () => ({ confirmed: [] }),
		});

		const declared = new Set(['Plan', 'Research', 'Synthesize', 'Review']);
		for (const call of calls) assert.ok(declared.has(call.opts.phase), `undeclared phase: ${call.opts.phase}`);
		for (const title of phases) assert.ok(declared.has(title), `undeclared phase(): ${title}`);
	});

	it('labels each researcher with its round', async () => {
		const { calls } = await runLoop({
			args: argsFor({ rounds: 2, width: 1 }),
			plan: planWith(2),
			research: () => ({ confirmed: [] }),
		});

		const labels = calls.filter((call) => call.opts.phase === 'Research').map((call) => call.opts.label);
		assert.deepEqual(labels, ['r1: q1', 'r2: q2']);
	});
});

describe('result assembly', () => {
	it('deduplicates sources across researchers, keeping first-seen order', async () => {
		const { result } = await runLoop({
			args: argsFor({ rounds: 1, width: 3 }),
			plan: planWith(3),
			research: (question) => ({
				confirmed: [
					{ claim: 'shared', source: 'https://example.test/shared' },
					{ claim: 'own', source: `https://example.test/${question}` },
				],
			}),
		});

		assert.deepEqual(result.sources, [
			'https://example.test/shared',
			'https://example.test/q1',
			'https://example.test/q2',
			'https://example.test/q3',
		]);
	});

	it('counts low-confidence claims separately', async () => {
		const { result } = await runLoop({
			args: argsFor({ rounds: 1, width: 2 }),
			plan: planWith(2),
			research: (question) => ({
				confirmed: [{ claim: 'c', source: 's', confidence: question === 'q1' ? 'low' : 'high' }],
			}),
		});

		assert.equal(result.coverage.claims, 2);
		assert.equal(result.coverage.lowConfidence, 1);
	});

	it('survives a researcher that omits every optional field', async () => {
		const { result } = await runLoop({
			args: argsFor({ rounds: 1, width: 1 }),
			plan: planWith(1),
			research: () => ({ confirmed: [] }),
		});

		assert.equal(result.coverage.researched, 1);
		assert.deepEqual(result.sources, []);
		assert.equal(result.coverage.uncertainties, 0);
	});
});
