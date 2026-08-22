/**
 * Turning a finished run into what the calling agent actually reads.
 *
 * The report is the substance and it is passed through untouched. What this
 * module adds is the audit trail underneath it: how much of the plan was
 * actually researched, what was never answered, how thin the evidence was. A
 * research report that arrives without those numbers reads as complete, and the
 * model relaying it to the user has no way to know it is not — so the numbers
 * travel with the text rather than sitting in a structured field nobody reads.
 *
 * @module @creait/dsh-research-mode/render
 */

/** English pluralisation; irregular plurals pass their own form. */
function plural(count, singular, many = `${singular}s`) {
	return `${count} ${count === 1 ? singular : many}`;
}

/**
 * Render the coverage footer: the facts that keep the report from reading as
 * more complete than the run was.
 * @param coverage - the run's `coverage` block.
 * @returns markdown, without a trailing newline.
 */
export function renderCoverage(coverage) {
	const lines = [];
	// Not "at a time": width is how many questions the round takes, not how many
	// researchers generate simultaneously. The engine queues a round against the
	// gen-limit's per-model ceiling, so on a narrower box the real concurrency is
	// lower and "at a time" would state a number that never happened.
	const width = coverage.width === undefined ? '' : ` at a width of ${coverage.width}`;
	const rounds = `${plural(coverage.rounds ?? 0, 'round')}${width}`;
	const followUps =
		(coverage.followUps ?? 0) > 0 ? `, plus ${plural(coverage.followUps, 'follow-up')} surfaced during the run` : '';

	lines.push(
		`Researched ${coverage.researched ?? 0} of ${plural(coverage.planned ?? 0, 'planned question')} over ${rounds}${followUps}.`,
	);

	const evidence = [];
	if ((coverage.claims ?? 0) > 0) evidence.push(plural(coverage.claims, 'sourced claim'));
	if ((coverage.lowConfidence ?? 0) > 0) evidence.push(`${coverage.lowConfidence} of them low-confidence`);
	if ((coverage.uncertainties ?? 0) > 0)
		evidence.push(plural(coverage.uncertainties, 'recorded uncertainty', 'recorded uncertainties'));
	if (evidence.length > 0) lines.push(`Evidence: ${evidence.join(', ')}.`);

	const unanswered = [...(coverage.deferred ?? []), ...(coverage.failed ?? [])];
	if (unanswered.length > 0) {
		lines.push('');
		lines.push(`Never answered (${unanswered.length}) — the report above does not cover these:`);
		for (const question of unanswered) lines.push(`- ${question}`);
	}
	if ((coverage.openLeads ?? 0) > 0) {
		lines.push('');
		lines.push(`${plural(coverage.openLeads, 'lead')} raised during research and not pursued.`);
	}
	if (coverage.reviewed === true) {
		lines.push('');
		lines.push('The report was reviewed against its own evidence for fabricated citations, overclaiming and coverage honesty, then revised.');
	}

	return lines.join('\n');
}

/**
 * Render the whole run for the calling agent.
 * @param value - the tool's canonical result.
 * @returns the report followed by its coverage footer.
 */
export function renderReport(value) {
	const report = typeof value?.report === 'string' ? value.report.trim() : '';
	const body = report === '' ? '_The run produced no report._' : report;
	return `${body}\n\n---\n\n${renderCoverage(value?.coverage ?? {})}`;
}
