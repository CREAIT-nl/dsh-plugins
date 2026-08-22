/**
 * The model-facing surface: the `deep_research` tool.
 *
 * The tool takes a topic and returns a report. What it does NOT take is the
 * orchestration — the agent does not write the loop, does not choose the fan-out
 * shape, and cannot skip the review stage by forgetting it exists. dsh already
 * ships a `workflow` tool for model-authored orchestration, and that is the
 * right seam for one-off fan-out; it is the wrong seam for research, because a
 * research script rewritten from scratch on every call re-earns the same
 * structural mistakes every call. Here the script is a fixed asset
 * (`./script.js`), reviewed once, and the model supplies parameters to it.
 *
 * This module is the AGENT-PLANE entry point: `@creait/dsh-research-mode/tool`,
 * mounted by the row inside `presets/research/agent.cordis.yml`. In every other
 * session it is never imported, the tool is never registered, and none of the
 * text below is in the context window.
 *
 * Its `workflowEngine` dependency is why this is a separate plugin from the
 * roster half. On the web surface the host plane disables the engine and each
 * preset mounts its own inside a realm, so this row has to sit in that realm —
 * see the preset — and the roster half must not declare the dependency at all.
 *
 * @module @creait/dsh-research-mode/tool
 */
import { pinnedWidth, RESEARCH_SETTINGS_NAMESPACE } from './config.js';
import { renderReport } from './render.js';
import { PLANNER_SCHEMA, RESEARCHER_SCHEMA } from './schemas.js';
import { RESEARCH_SCRIPT } from './script.js';

/** The workflow's identity block. Phase titles must match the script's `phase()` calls exactly. */
const META = {
	name: 'deep-research',
	description: 'Plan a research topic into sub-questions, research them in adaptive parallel rounds, then synthesise and review a cited report.',
	phases: [
		{ title: 'Plan', detail: 'decompose the topic into researchable sub-questions within the round budget' },
		{ title: 'Research', detail: 'one agent per sub-question, per round; high-priority gaps become the next round' },
		{ title: 'Synthesize', detail: 'write the cited report from the collected evidence' },
		{ title: 'Review', detail: 'check the report against its own evidence, then revise' },
	],
};

/** One never-answered question, in the structured result. */
const QUESTION_LIST = { type: 'array', items: { type: 'string' } };

/** The tool's canonical output. */
const OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		topic: { type: 'string' },
		scope: { type: 'string' },
		dimensions: { type: 'array', items: { type: 'string' } },
		report: { type: 'string' },
		sources: { type: 'array', items: { type: 'string' } },
		coverage: {
			type: 'object',
			additionalProperties: false,
			properties: {
				planned: { type: 'number' },
				followUps: { type: 'number' },
				researched: { type: 'number' },
				deferred: QUESTION_LIST,
				failed: QUESTION_LIST,
				openLeads: { type: 'number' },
				rounds: { type: 'number' },
				roundBudget: { type: 'number' },
				width: { type: 'number' },
				claims: { type: 'number' },
				lowConfidence: { type: 'number' },
				uncertainties: { type: 'number' },
				reviewed: { type: 'boolean' },
			},
		},
	},
};

const DESCRIPTION =
	'Run a full multi-agent research pass on a topic and return a cited report. The topic is planned into independent sub-questions, each researched by its own agent with web search and page fetching, in adaptive rounds — high-priority gaps found in one round become the next round\'s questions — then synthesised into a report and checked against its own evidence for fabricated citations and overclaiming. Use it when the answer needs several independent lines of enquiry, current sources, or a written deliverable someone else will read. Do NOT use it for a single lookup: one fact, one definition, one current value, or anything a couple of web_search calls settle — this spawns many agents and takes minutes, and on a simple question it is strictly worse than searching yourself. The result carries its own coverage accounting: how many planned questions were actually researched, and which were never answered because the round budget ran out or a researcher failed. Those unanswered questions are real holes in the report — relay them to the user rather than presenting the report as complete coverage of the topic.';

/** Clamp a model-supplied positive integer into a configured range. */
function clamp(value, fallback, min, max) {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

/** Today's date, as the researchers should see it. */
function today() {
	return new Date().toISOString().slice(0, 10);
}

/** Normalise the model's question list into non-empty trimmed strings. */
function cleanQuestions(questions) {
	if (!Array.isArray(questions)) return [];
	return questions.map((question) => String(question ?? '').trim()).filter((question) => question !== '');
}

/**
 * The width the user pinned in the composer, read live from the settings
 * namespace the roster half registers.
 *
 * Read rather than injected: the roster half runs on the host plane and this one
 * inside the preset's realm, and the whole point of that split is that neither
 * depends on the other mounting. A missing settings service, a namespace nobody
 * ever wrote, a harness that moved the API — all of them mean "no pin", which is
 * exactly the behaviour this tool had before the control existed.
 * @param ctx - the tool half's plugin context.
 * @returns the pinned width, or `undefined` when nothing is pinned.
 */
export function readPinnedWidth(ctx) {
	try {
		const settings = ctx?.get?.('settings', false);
		if (settings === undefined || settings === null) return undefined;
		const descriptor = settings
			.describe({ redactSecrets: true })
			.find((candidate) => String(candidate.ns) === RESEARCH_SETTINGS_NAMESPACE);
		return pinnedWidth(descriptor?.value);
	} catch {
		return undefined;
	}
}

/**
 * Build the `args` payload the script reads. Everything variable lives here, so
 * the script stays a constant and nothing is interpolated into executable text.
 * @param args - the validated tool arguments.
 * @param config - the plugin row's config.
 * @param pinned - the user's composer-pinned width, when they set one. It BEATS
 *   the model's `width` argument: the model picked its number from the topic,
 *   the operator picked theirs from the deployment, and the operator is the one
 *   who knows how broad a brief this box should be asked for. This shapes the
 *   report, not the load — a round wider than gen-limit's per-model ceiling
 *   queues rather than failing. Still clamped to `maxWidth` like any other width.
 * @returns plain JSON for the workflow's `args` global.
 */
export function buildArgs(args, config, pinned) {
	const maxRounds = config?.maxRounds ?? 6;
	const maxWidth = config?.maxWidth ?? 8;
	const requestedWidth = pinned === undefined ? args?.width : pinned;
	return {
		topic: String(args?.topic ?? '').trim(),
		questions: cleanQuestions(args?.questions),
		rounds: clamp(args?.rounds, config?.rounds ?? 3, 1, maxRounds),
		width: clamp(requestedWidth, config?.width ?? 4, 1, maxWidth),
		audience: String(args?.audience ?? '').trim(),
		language: String(args?.language ?? config?.language ?? 'English').trim(),
		review: args?.review === undefined ? config?.review !== false : args.review === true,
		today: today(),
		schemas: { planner: PLANNER_SCHEMA, researcher: RESEARCHER_SCHEMA },
	};
}

/**
 * Shape the workflow's return value into the tool's canonical output. Done by
 * hand rather than passed through: the script is the thing most likely to grow a
 * field, and a schema violation there would surface as a tool failure after the
 * whole run had already been paid for.
 * @param value - whatever the script returned.
 * @param request - the resolved script args, for the fields worth echoing back.
 * @returns a value matching {@link OUTPUT_SCHEMA}.
 */
export function shapeResult(value, request) {
	const source = value !== null && typeof value === 'object' ? value : {};
	const coverage = source.coverage !== null && typeof source.coverage === 'object' ? source.coverage : {};
	const strings = (list) => (Array.isArray(list) ? list.map((item) => String(item)) : []);
	const count = (number) => (typeof number === 'number' && Number.isFinite(number) ? number : 0);

	return {
		topic: String(source.topic ?? request.topic),
		scope: String(source.scope ?? ''),
		dimensions: strings(source.dimensions),
		report: String(source.report ?? ''),
		sources: strings(source.sources),
		coverage: {
			planned: count(coverage.planned),
			followUps: count(coverage.followUps),
			researched: count(coverage.researched),
			deferred: strings(coverage.deferred),
			failed: strings(coverage.failed),
			openLeads: count(coverage.openLeads),
			rounds: count(coverage.rounds),
			roundBudget: count(coverage.roundBudget),
			width: count(coverage.width),
			claims: count(coverage.claims),
			lowConfidence: count(coverage.lowConfidence),
			uncertainties: count(coverage.uncertainties),
			reviewed: coverage.reviewed === true,
		},
	};
}

/** A non-`completed` stop reason means the run did not finish; there is no partial report to hand back. */
function stopReasonError(result) {
	switch (result.stopReason) {
		case 'completed':
			return undefined;
		case 'cancelled':
			return `the research run was cancelled${result.error === undefined ? '' : ` (${result.error})`}`;
		default:
			return `the research run failed: ${result.error ?? 'unknown error'}`;
	}
}

/** The `deep_research` tool definition. */
export function toolDefinition(ctx, config) {
	return {
		name: config?.toolName ?? 'deep_research',
		description: DESCRIPTION,
		parameters: {
			type: 'object',
			additionalProperties: false,
			required: ['topic'],
			properties: {
				topic: {
					type: 'string',
					description:
						'What to research, stated as the question the report has to answer. Include the constraints that matter — the decision behind it, the versions or jurisdictions in scope, the time window — because the planner sees this string and nothing else about the conversation.',
				},
				questions: {
					type: 'array',
					items: { type: 'string' },
					description:
						'Sub-questions that MUST be researched. They are used verbatim and researched first; the planner still audits them for coverage and adds what they miss. Supply these only when you already know the specific angles; otherwise leave it out and let the planner decompose the topic.',
				},
				rounds: {
					type: 'integer',
					description:
						'How many adaptive research rounds to run. Each round researches up to `width` questions and can surface follow-ups for the next one. More rounds buy depth on what the research turns up, not breadth. Omit for the configured default.',
				},
				width: {
					type: 'integer',
					description:
						'How many questions to research in parallel per round. More width buys breadth of coverage. Omit for the configured default. The user can also pin a width in the composer, and a pin overrides whatever you pass here — the result\'s `coverage.width` is what actually ran.',
				},
				audience: {
					type: 'string',
					description:
						'Who the report is written for, when it changes what belongs in it — "an engineer choosing between these two libraries", "a non-technical stakeholder". Omit when it does not.',
				},
				language: {
					type: 'string',
					description: 'The language the report is written in. Defaults to the configured language.',
				},
				review: {
					type: 'boolean',
					description:
						'Whether to run the adversarial review pass, which checks the report against its own evidence for fabricated citations and overclaiming and then revises it. On by default; turn it off only for a quick, low-stakes pass.',
				},
			},
		},
		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
		},
		async execute(args, exec) {
			const topic = String(args?.topic ?? '').trim();
			if (topic === '') throw new Error('deep_research needs a topic');

			const parent = exec?.agent;
			if (parent === undefined) throw new Error('deep_research needs a calling agent (exec.agent was undefined)');

			const request = buildArgs(args, config, readPinnedWidth(ctx));
			const run = ctx.workflowEngine.start({
				script: RESEARCH_SCRIPT,
				meta: META,
				args: request,
				parent,
				// The whole run is bounded: planner + rounds×width researchers +
				// synthesis + review + revision, with a little slack. Without a cap a
				// follow-up storm could keep queueing work the engine would keep
				// starting, and the ceiling below is the engine's, not this tool's.
				maxTotalAgents: request.rounds * request.width + 8,
				...(exec?.signal === undefined ? {} : { signal: exec.signal }),
			});

			const onAbort = () => {
				run.cancel('the calling step was aborted');
			};
			exec?.signal?.addEventListener('abort', onAbort, { once: true });

			try {
				const result = await run.result;
				const failure = stopReasonError(result);
				if (failure !== undefined) throw new Error(failure);
				return shapeResult(result.value, request);
			} finally {
				exec?.signal?.removeEventListener('abort', onAbort);
				await run.dispose();
			}
		},
		presentCall: (args) => ({
			card: 'generic',
			title: `deep research: ${String(args?.topic ?? '')}`,
		}),
	};
}

/** Stable Cordis plugin name. */
export const name = 'research-mode-tool';

/**
 * The registries this half needs. `tools` is host-plane; `workflowEngine` is
 * provided by the `workflow-worker-thread` row sharing this preset's realm, and
 * declaring it here is what makes the row wait for that mount rather than
 * registering a tool whose engine is not there yet.
 */
export const inject = ['tools', 'workflowEngine'];

/**
 * Register the tool. An agent-plane surface: nothing here runs in a normal session.
 * @param ctx - host plugin context.
 * @param config - `{ toolName?, rounds?, width?, maxRounds?, maxWidth?, review?, language? }`.
 *   `rounds`/`width` are the defaults a call gets when the model names neither;
 *   `maxRounds`/`maxWidth` are the ceilings it cannot argue past, including over
 *   a width pinned in the composer. `review: false`
 *   turns the adversarial pass off by default. `language` is the report language.
 */
export function apply(ctx, config) {
	const definition = toolDefinition(ctx, config ?? {});
	ctx.effect(() => ctx.tools.register(definition), 'research-mode: deep_research tool');
}
