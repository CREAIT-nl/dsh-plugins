/**
 * The model-facing tool.
 *
 * Two things matter here and neither is the happy path. The first is that the
 * model cannot argue its way past the configured ceilings — `rounds` and `width`
 * are cost, and a tool whose cost the model sets is a tool that occasionally
 * spends forty agents on a definition. The second is that the run's own return
 * value is re-shaped rather than trusted: a schema violation on the way out
 * would fail the call after the entire run had already been paid for.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildArgs, readPinnedWidth, shapeResult, toolDefinition } from '../lib/tool.js';

/** A workflow engine that records its request and answers with a fixed result. */
function stubEngine(result, hooks = {}) {
	const started = [];
	const disposed = [];
	const cancelled = [];
	const engine = {
		start(request) {
			started.push(request);
			const run = {
				id: `wf_${started.length}`,
				meta: request.meta,
				result: hooks.result ? hooks.result(request) : Promise.resolve(result),
				cancel(reason) {
					cancelled.push(reason);
				},
				dispose() {
					disposed.push(run.id);
					return Promise.resolve();
				},
			};
			return run;
		},
	};
	return { ctx: { workflowEngine: engine }, started, disposed, cancelled };
}

/** A completed run whose script returned `value`. */
function completed(value) {
	return { value, stopReason: 'completed', agentsStarted: 7 };
}

const AGENT = { id: 'agent-1' };

describe('buildArgs', () => {
	it('falls back to the configured defaults when the model names nothing', () => {
		const request = buildArgs({ topic: '  a topic  ' }, { rounds: 3, width: 4, language: 'English' });
		assert.equal(request.topic, 'a topic');
		assert.equal(request.rounds, 3);
		assert.equal(request.width, 4);
		assert.equal(request.language, 'English');
		assert.deepEqual(request.questions, []);
	});

	it('clamps the model into the configured ceilings', () => {
		const request = buildArgs({ topic: 't', rounds: 99, width: 40 }, { maxRounds: 6, maxWidth: 8 });
		assert.equal(request.rounds, 6);
		assert.equal(request.width, 8);
	});

	it('clamps up from zero and negatives, which would otherwise research nothing', () => {
		const request = buildArgs({ topic: 't', rounds: 0, width: -3 }, {});
		assert.equal(request.rounds, 1);
		assert.equal(request.width, 1);
	});

	it('rounds a fractional count rather than passing it to the loop', () => {
		assert.equal(buildArgs({ topic: 't', rounds: 2.6 }, {}).rounds, 3);
	});

	it('ignores a non-numeric count', () => {
		const request = buildArgs({ topic: 't', rounds: 'lots', width: Number.NaN }, { rounds: 3, width: 4 });
		assert.equal(request.rounds, 3);
		assert.equal(request.width, 4);
	});

	it('drops empty supplied questions instead of researching whitespace', () => {
		const request = buildArgs({ topic: 't', questions: ['  real  ', '', '   ', null] }, {});
		assert.deepEqual(request.questions, ['real']);
	});

	it('reviews by default, and honours both an explicit call and an explicit config', () => {
		assert.equal(buildArgs({ topic: 't' }, {}).review, true);
		assert.equal(buildArgs({ topic: 't' }, { review: false }).review, false);
		assert.equal(buildArgs({ topic: 't', review: false }, {}).review, false);
		// A call-site `true` beats a config default of `false`: the model can
		// always ask for more rigour, never for less than it asked for.
		assert.equal(buildArgs({ topic: 't', review: true }, { review: false }).review, true);
	});

	// The pin exists because the model chooses width from the topic and the
	// operator chooses it from the deployment. It shapes how broad a brief this
	// box is asked for; it is not the capacity control. A round wider than the
	// gen-limit queues the overflow rather than failing it, so clamping
	// width down to that number would only research fewer questions.
	it('lets a pinned width beat the width the model asked for', () => {
		const request = buildArgs({ topic: 't', width: 6 }, { width: 4, maxWidth: 8 }, 3);
		assert.equal(request.width, 3);
	});

	it('still clamps a pin to the ceiling the model could not argue past either', () => {
		assert.equal(buildArgs({ topic: 't' }, { maxWidth: 4 }, 99).width, 4);
	});

	it('leaves the model in charge when nothing is pinned', () => {
		assert.equal(buildArgs({ topic: 't', width: 6 }, { width: 4, maxWidth: 8 }, undefined).width, 6);
	});

	it('carries the schemas and today\'s date, so the script stays a constant', () => {
		const request = buildArgs({ topic: 't' }, {});
		assert.match(request.today, /^\d{4}-\d{2}-\d{2}$/);
		assert.equal(request.schemas.planner.type, 'object');
		assert.ok(request.schemas.researcher.properties.confirmed);
	});
});

describe('shapeResult', () => {
	it('shapes a full result into the declared output', () => {
		const shaped = shapeResult(
			{
				topic: 't',
				scope: 's',
				dimensions: ['d'],
				report: '# R',
				sources: ['https://example.test/'],
				coverage: { planned: 4, researched: 3, deferred: ['q4'], reviewed: true },
			},
			{ topic: 'fallback' },
		);

		assert.equal(shaped.report, '# R');
		assert.deepEqual(shaped.coverage.deferred, ['q4']);
		assert.equal(shaped.coverage.reviewed, true);
		assert.equal(shaped.coverage.failed.length, 0);
	});

	it('drops a field the script grew, rather than failing the call over it', () => {
		const shaped = shapeResult({ report: '# R', surprise: 1, coverage: { planned: 1, surprise: 2 } }, { topic: 't' });
		assert.equal('surprise' in shaped, false);
		assert.equal('surprise' in shaped.coverage, false);
	});

	it('falls back to the requested topic when the script omits one', () => {
		assert.equal(shapeResult({}, { topic: 'the request topic' }).topic, 'the request topic');
	});

	it('shapes a null return into an empty report rather than throwing', () => {
		const shaped = shapeResult(null, { topic: 't' });
		assert.equal(shaped.report, '');
		assert.deepEqual(shaped.sources, []);
		assert.equal(shaped.coverage.planned, 0);
		assert.equal(shaped.coverage.reviewed, false);
	});
});

describe('the deep_research tool', () => {
	it('declares only topic as required', () => {
		const definition = toolDefinition(stubEngine(completed({})).ctx, {});
		assert.equal(definition.name, 'deep_research');
		assert.deepEqual(definition.parameters.required, ['topic']);
		assert.equal(definition.parameters.additionalProperties, false);
	});

	it('can be renamed by config', () => {
		assert.equal(toolDefinition({}, { toolName: 'research' }).name, 'research');
	});

	it('starts the run with the fixed script and matching phase titles', async () => {
		const engine = stubEngine(completed({ report: '# R', coverage: { planned: 2, researched: 2 } }));
		const definition = toolDefinition(engine.ctx, { rounds: 2, width: 3 });

		await definition.execute({ topic: 'a topic' }, { agent: AGENT });

		const [request] = engine.started;
		assert.equal(request.parent, AGENT);
		assert.match(request.script, /phase\('Plan'\)/);
		assert.equal(request.args.topic, 'a topic');
		assert.equal(request.maxTotalAgents, 2 * 3 + 8);

		const declared = new Set(request.meta.phases.map((phase) => phase.title));
		for (const title of ['Plan', 'Research', 'Synthesize', 'Review']) assert.ok(declared.has(title));
		for (const title of declared) {
			assert.match(request.script, new RegExp(`phase\\('${title}'\\)`), `script never enters phase ${title}`);
		}
	});

	it('sizes the agent cap to the clamped counts, not the requested ones', async () => {
		const engine = stubEngine(completed({}));
		const definition = toolDefinition(engine.ctx, { maxRounds: 2, maxWidth: 2 });

		await definition.execute({ topic: 't', rounds: 50, width: 50 }, { agent: AGENT });

		assert.equal(engine.started[0].maxTotalAgents, 2 * 2 + 8);
	});

	it('refuses an empty topic before spending anything', async () => {
		const engine = stubEngine(completed({}));
		const definition = toolDefinition(engine.ctx, {});

		await assert.rejects(definition.execute({ topic: '   ' }, { agent: AGENT }), /needs a topic/);
		assert.equal(engine.started.length, 0);
	});

	it('refuses when there is no calling agent for the engine to parent to', async () => {
		const engine = stubEngine(completed({}));
		await assert.rejects(toolDefinition(engine.ctx, {}).execute({ topic: 't' }, {}), /needs a calling agent/);
		assert.equal(engine.started.length, 0);
	});

	it('turns a non-completed stop reason into an error, not a half report', async () => {
		const cancelled = stubEngine({ value: undefined, stopReason: 'cancelled', agentsStarted: 3 });
		await assert.rejects(
			toolDefinition(cancelled.ctx, {}).execute({ topic: 't' }, { agent: AGENT }),
			/the research run was cancelled/,
		);

		const failed = stubEngine({ value: undefined, stopReason: 'error', error: 'AGENT_CAP', agentsStarted: 3 });
		await assert.rejects(
			toolDefinition(failed.ctx, {}).execute({ topic: 't' }, { agent: AGENT }),
			/the research run failed: AGENT_CAP/,
		);
	});

	it('disposes the run even when it failed', async () => {
		const engine = stubEngine({ value: undefined, stopReason: 'error', error: 'boom', agentsStarted: 1 });
		await assert.rejects(toolDefinition(engine.ctx, {}).execute({ topic: 't' }, { agent: AGENT }));
		assert.deepEqual(engine.disposed, ['wf_1']);
	});

	it('disposes the run when it succeeded', async () => {
		const engine = stubEngine(completed({ report: '# R' }));
		await toolDefinition(engine.ctx, {}).execute({ topic: 't' }, { agent: AGENT });
		assert.deepEqual(engine.disposed, ['wf_1']);
	});

	it('cancels the run when the calling step is aborted', async () => {
		const controller = new AbortController();
		const engine = stubEngine(undefined, {
			result: () =>
				new Promise((resolve) => {
					controller.signal.addEventListener('abort', () =>
						resolve({ value: undefined, stopReason: 'cancelled', agentsStarted: 1 }),
					);
				}),
		});

		const call = toolDefinition(engine.ctx, {}).execute({ topic: 't' }, { agent: AGENT, signal: controller.signal });
		controller.abort();

		await assert.rejects(call, /cancelled/);
		assert.deepEqual(engine.cancelled, ['the calling step was aborted']);
		assert.equal(engine.started[0].signal, controller.signal);
	});

	it('renders the report with its coverage footer attached', () => {
		const definition = toolDefinition({}, {});
		const [block] = definition.output.render(
			{ topic: 't' },
			{ report: '# Findings', coverage: { planned: 5, researched: 3, deferred: ['q4', 'q5'] } },
		);

		assert.equal(block.type, 'text');
		assert.match(block.text, /^# Findings\n\n---\n\n/);
		assert.match(block.text, /Never answered \(2\)/);
	});

	it('titles the call with its topic', () => {
		assert.match(toolDefinition({}, {}).presentCall({ topic: 'sparse autoencoders' }).title, /sparse autoencoders/);
	});
});

describe('readPinnedWidth', () => {
	/** A settings service holding one namespace value. */
	const settingsWith = (value) => ({
		get: (name) => (name === 'settings'
			? { describe: () => [{ ns: 'dsh-research-mode', value, revision: 1 }] }
			: undefined),
	});

	it('reads the pin the roster half persisted', () => {
		assert.equal(readPinnedWidth(settingsWith({ width: 3 })), 3);
	});

	it('treats zero as no pin, which is what auto means', () => {
		assert.equal(readPinnedWidth(settingsWith({ width: 0 })), undefined);
	});

	// Every one of these is a live deployment: a headless mount with no settings
	// provider, a namespace nobody has written, a harness that moved the API.
	// All of them have to mean "the model decides", because that is exactly what
	// this tool did before the control existed.
	it('means no pin whenever it cannot read one', () => {
		assert.equal(readPinnedWidth(undefined), undefined);
		assert.equal(readPinnedWidth({}), undefined);
		assert.equal(readPinnedWidth({ get: () => undefined }), undefined);
		assert.equal(readPinnedWidth({ get: () => ({ describe: () => [] }) }), undefined);
		assert.equal(readPinnedWidth({ get: () => ({ describe() { throw new Error('moved'); } }) }), undefined);
	});
});
