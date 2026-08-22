/**
 * The coverage footer.
 *
 * These assertions are about honesty rather than formatting: the numbers exist
 * so a report that answered four of ten questions cannot be relayed as if it
 * answered ten, and the tests pin the cases where that could quietly stop being
 * true — a deferred question that never gets named, a footer that omits itself
 * because a field was missing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderCoverage, renderReport } from '../lib/render.js';

describe('renderCoverage', () => {
	it('states what was researched against what was planned', () => {
		const text = renderCoverage({ planned: 8, researched: 6, rounds: 2, width: 3 });
		assert.equal(text, 'Researched 6 of 8 planned questions over 2 rounds at a width of 3.');
	});

	it('counts follow-ups separately from the plan', () => {
		const text = renderCoverage({ planned: 4, researched: 6, followUps: 2, rounds: 2, width: 3 });
		assert.match(text, /plus 2 follow-ups surfaced during the run\./);
	});

	it('names every unanswered question, deferred and failed alike', () => {
		const text = renderCoverage({
			planned: 4,
			researched: 2,
			deferred: ['what does it cost?'],
			failed: ['who maintains it?'],
		});

		assert.match(text, /Never answered \(2\) — the report above does not cover these:/);
		assert.match(text, /- what does it cost\?/);
		assert.match(text, /- who maintains it\?/);
	});

	it('says nothing about unanswered questions when there are none', () => {
		const text = renderCoverage({ planned: 3, researched: 3, deferred: [], failed: [] });
		assert.doesNotMatch(text, /Never answered/);
	});

	it('summarises the evidence, and how thin it is', () => {
		const text = renderCoverage({ planned: 2, researched: 2, claims: 14, lowConfidence: 3, uncertainties: 5 });
		assert.match(text, /Evidence: 14 sourced claims, 3 of them low-confidence, 5 recorded uncertainties\./);
	});

	it('omits the evidence line entirely when there is no evidence to report', () => {
		const text = renderCoverage({ planned: 1, researched: 1 });
		assert.doesNotMatch(text, /Evidence:/);
	});

	it('inflects singulars', () => {
		const text = renderCoverage({
			planned: 1,
			researched: 1,
			rounds: 1,
			width: 1,
			followUps: 1,
			claims: 1,
			uncertainties: 1,
			openLeads: 1,
		});

		assert.match(text, /1 planned question over 1 round at a width of 1, plus 1 follow-up/);
		assert.match(text, /Evidence: 1 sourced claim, 1 recorded uncertainty\./);
		assert.match(text, /1 lead raised during research and not pursued\./);
	});

	it('reports unpursued leads', () => {
		const text = renderCoverage({ planned: 2, researched: 2, openLeads: 4 });
		assert.match(text, /4 leads raised during research and not pursued\./);
	});

	it('mentions the review only when one happened', () => {
		assert.match(renderCoverage({ reviewed: true }), /reviewed against its own evidence/);
		assert.doesNotMatch(renderCoverage({ reviewed: false }), /reviewed against its own evidence/);
	});

	it('renders an empty coverage block without throwing', () => {
		assert.equal(renderCoverage({}), 'Researched 0 of 0 planned questions over 0 rounds.');
	});
});

describe('renderReport', () => {
	it('passes the report through untouched, above its footer', () => {
		const text = renderReport({
			report: '# Findings\n\nThe body.',
			coverage: { planned: 2, researched: 2, rounds: 1, width: 2 },
		});

		assert.match(text, /^# Findings\n\nThe body\.\n\n---\n\n/);
		assert.match(text, /Researched 2 of 2 planned questions/);
	});

	it('still renders the coverage when there is no report', () => {
		const text = renderReport({ report: '   ', coverage: { planned: 3, researched: 0, failed: ['q1'] } });
		assert.match(text, /_The run produced no report\._/);
		assert.match(text, /- q1/);
	});

	it('survives a missing value entirely', () => {
		assert.match(renderReport(undefined), /_The run produced no report\._/);
	});
});
