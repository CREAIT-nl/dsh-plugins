/**
 * Running the research loop without a harness, a model or a network.
 *
 * The script is the deliverable, and its interesting properties are all in the
 * control flow: what happens to work when the budget runs out, whether a lead is
 * queued or dropped, whether the same gap gets chased twice. Those are testable
 * exactly the way the engine runs them — a `node:vm` context with the same six
 * globals and the same `(async () => { … })()` wrapper — with `agent` replaced by
 * a function that answers from a script instead of a model.
 *
 * @module @creait/dsh-research-mode/test/harness
 */
import vm from 'node:vm';

import { RESEARCH_SCRIPT } from '../lib/script.js';

/**
 * Run the research script against stubbed agents.
 *
 * @param options - `{ args, plan, research, synthesis, review, revision }`.
 *   `plan` is the planner's answer (or null to fail it). `research` is either a
 *   function `(question, call) => answer|null` or a map keyed by question text.
 *   The rest are the text stages, each a string, null, or a function of the
 *   prompt.
 * @returns `{ result, calls, logs, phases }` — `calls` records every `agent()`
 *   invocation in order, with its prompt and options.
 */
export async function runLoop(options = {}) {
	const calls = [];
	const logs = [];
	const phases = [];

	// `?? default` would be wrong here: an explicit `null` is how a test says
	// "this stage fails", and that is exactly the value `??` swallows.
	const stage = (key, fallback) => (key in options ? options[key] : fallback);

	const answerFor = (prompt, opts) => {
		const label = opts?.label ?? '';
		if (label === 'plan') return resolve(stage('plan', null), prompt);
		if (label === 'synthesise') return resolve(stage('synthesis', '# Report\n\nBody.'), prompt);
		if (label === 'review') return resolve(stage('review', 'No defects found.'), prompt);
		if (label === 'revise') return resolve(stage('revision', '# Report (revised)\n\nBody.'), prompt);
		return researchAnswer(stage('research', undefined), prompt, calls.length);
	};

	const context = vm.createContext({});
	Object.assign(context, {
		agent: async (prompt, opts) => {
			calls.push({ prompt, opts: opts ?? {} });
			return answerFor(prompt, opts);
		},
		parallel: async (thunks) => {
			const settled = await Promise.allSettled(thunks.map((thunk) => thunk()));
			return settled.map((entry) => (entry.status === 'fulfilled' ? entry.value : null));
		},
		pipeline: async () => {
			throw new Error('pipeline() is not used by this script');
		},
		phase: (title) => {
			phases.push(title);
		},
		log: (message) => {
			logs.push(message);
		},
		args: structuredClone(options.args),
	});

	const script = new vm.Script(`(async () => {\n${RESEARCH_SCRIPT}\n})()`, {
		filename: 'workflow:deep-research',
		lineOffset: -1,
	});
	// The real engine hands the result back across a worker-thread boundary, so
	// what a caller sees is always a structured clone. Cloning here reproduces
	// that — and incidentally keeps assertions off vm-realm Array prototypes.
	const result = structuredClone(await script.runInContext(context));
	return { result, calls, logs, phases };
}

/** Resolve a stage stub: a function of the prompt, or a fixed value. */
function resolve(value, prompt) {
	return typeof value === 'function' ? value(prompt) : (value ?? null);
}

/** Pull the assigned sub-question back out of a researcher prompt. */
export function questionOf(prompt) {
	const marker = 'YOUR SUB-QUESTION\n';
	const start = prompt.indexOf(marker);
	if (start === -1) return '';
	const from = start + marker.length;
	const end = prompt.indexOf('\n', from);
	return end === -1 ? prompt.slice(from) : prompt.slice(from, end);
}

/** Answer one researcher from a function or a question-keyed map. */
function researchAnswer(research, prompt, index) {
	const question = questionOf(prompt);
	if (typeof research === 'function') return research(question, index, prompt);
	if (research !== null && typeof research === 'object') {
		const answer = research[question];
		return answer === undefined ? { confirmed: [] } : answer;
	}
	return { confirmed: [] };
}

/** Build the `args` payload the script expects, with test-friendly defaults. */
export function argsFor(overrides = {}) {
	return {
		topic: 'How do sparse autoencoders localise features?',
		questions: [],
		rounds: 2,
		width: 3,
		audience: '',
		language: 'English',
		today: '2026-08-22',
		review: false,
		schemas: { planner: { type: 'object' }, researcher: { type: 'object' } },
		...overrides,
	};
}

/** Build a planner answer with `count` questions, named `q1`…`qN`. */
export function planWith(count, overrides = {}) {
	const questions = [];
	for (let i = 1; i <= count; i += 1) {
		questions.push({ question: `q${i}`, dimension: 'd1', keywords: 'k', acceptance: 'a' });
	}
	return { scope: 'the scope', dimensions: ['d1'], questions, coverage_gaps: [], ...overrides };
}
