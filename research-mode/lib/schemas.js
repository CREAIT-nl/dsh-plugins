/**
 * Structured-output schemas for the research loop's sub-agents.
 *
 * These are the load-bearing part of the design: a sub-agent that returns prose
 * has to be parsed, and a parser over model prose is where a research pipeline
 * quietly starts inventing things. Forcing JSON at the tool-call layer means the
 * engine retries a malformed answer instead of the script guessing at one.
 *
 * @module @creait/dsh-research-mode/schemas
 */

/**
 * The planner's answer: the reference signal for everything downstream.
 *
 * `scope` is what stops the loop optimising for the wrong question — it names
 * the decision the report has to support. `dimensions` is the coverage baseline
 * the reviewer later audits against. `coverage_gaps` is the planner's own
 * declared blind spots, which the loop turns into reconnaissance tasks rather
 * than trusting.
 */
export const PLANNER_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		scope: { type: 'string' },
		dimensions: { type: 'array', items: { type: 'string' } },
		questions: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					question: { type: 'string' },
					dimension: { type: 'string' },
					keywords: { type: 'string' },
					acceptance: { type: 'string' },
				},
				required: ['question', 'dimension'],
			},
		},
		coverage_gaps: { type: 'array', items: { type: 'string' } },
	},
	required: ['scope', 'dimensions', 'questions', 'coverage_gaps'],
};

/**
 * A researcher's answer: a three-state evidence model.
 *
 * Splitting `confirmed` from `uncertain` from `gaps` is what lets the report
 * preserve uncertainty instead of flattening it. `gaps[].priority` is also the
 * loop's control signal — high-priority gaps are what the next round chases.
 */
export const RESEARCHER_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		confirmed: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					claim: { type: 'string' },
					source: { type: 'string' },
					confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
				},
				required: ['claim', 'source'],
			},
		},
		uncertain: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					point: { type: 'string' },
					reason: { type: 'string' },
				},
				required: ['point'],
			},
		},
		gaps: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					aspect: { type: 'string' },
					priority: { type: 'string', enum: ['high', 'medium', 'low'] },
				},
				required: ['aspect'],
			},
		},
	},
	required: ['confirmed'],
};
