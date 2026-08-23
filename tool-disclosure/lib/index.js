/**
 * Progressive tool disclosure for DeepSeek Harness: a tool group the model
 * rarely needs costs one catalog line instead of its full schemas, until the
 * model asks for it.
 *
 * The harness advertises every registered tool on every request. That is the
 * right default for the tools a session actually uses, and an unbounded tax
 * for the ones it does not: mounting an MCP server host-plane adds its whole
 * schema set to every request in every mode, whether or not the session ever
 * touches it.
 *
 * What this row does is narrow: it removes deferred tools from the ASSEMBLED
 * REQUEST and names their groups in one prompt section instead. It does not
 * touch the registry. `ctx.tools.restrict()` would, and deliberately is not
 * used — one resolver there feeds presentation, lookup AND dispatch, so a
 * restricted tool is genuinely uncallable and the model can be stranded with
 * `UNKNOWN_TOOL` for a capability the catalog just advertised. Restricting
 * also validates names when the restriction is installed, which an MCP server
 * that registers its tools after its handshake cannot satisfy.
 *
 * Filtering presentation alone has neither problem: a deferred tool stays
 * fully callable the moment anything names it, and the catalog is recomputed
 * from the live registry at every step.
 *
 * Every tool the registry holds belongs to a group. Most are discovered — an
 * MCP server's tools bucketed under its name — and the profile patch can
 * annotate any of them with a chosen id, its own globs and a hand-written
 * summary. What the settings page owns is one switch per group, deferred or
 * advertised in full, persisted in the `dsh-tool-disclosure` settings
 * namespace and applied without a restart.
 *
 * @module @creait/dsh-tool-disclosure
 */

import { installSettingsSection } from '@deepseek-ai/dsh-settings';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { Config, SEARCH_TOOL, compileDiscovered, compileGroups, compilePattern, deferredGroups, partition, readConfig, renderCatalog, resolve, withSummaries } from './catalog.js';
import { TOOL_DISCLOSURE_SETTINGS_NAMESPACE, makeSettingsRoutes } from './settings-routes.js';

/** Cordis plugin name. */
const name = 'tool-disclosure';

/** Required services. */
const inject = ['tools', 'systemPrompt'];

/**
 * Prompt order for the catalog. Each tool registers its own guidance in the
 * 100-199 band (`dsh-tool-web` takes 110 and 111); the catalog belongs after
 * that guidance — it is a statement about tools the model has NOT been given
 * guidance for — and before the generated SDK section at 150.
 */
const CATALOG_ORDER = 120;

/**
 * Mount the disclosure layer.
 * @param ctx - the mounting context; host-plane, so one row covers every mode.
 * @param config - the group annotations, never-defer globs and switch list.
 */
function apply(ctx, config) {
	/** The live merged config: the row's entry until a settings scope replaces it. */
	let source = () => config;

	/** Every group the patch annotates, compiled. */
	let groups = [];
	/** The groups actually deferring anything: the ones switched on. */
	let active = [];
	/** Compiled never-defer globs. */
	let keep = [];
	/** The `tool_search` registration, present only while a group defers. */
	let toolDisposer;

	/**
	 * Groups each live agent has loaded. Keyed by the agent object rather than
	 * its id: `context.agent` at assembly and `exec.agent` in the tool are the
	 * same instance, and a WeakMap needs no `agent/disposed` listener to avoid
	 * outliving the session.
	 */
	const loadedByAgent = new WeakMap();

	/** This agent's loaded-group set, created on first need. */
	function loadedFor(agent) {
		const loaded = loadedByAgent.get(agent);
		if (loaded !== undefined) return loaded;
		const created = new Set();
		loadedByAgent.set(agent, created);
		return created;
	}

	/**
	 * Whether this agent's tools reach the model as native schemas. Under a
	 * Code Mode presentation every tool is rendered into the generated SDK
	 * section instead, which this row cannot filter — so it defers nothing
	 * there rather than advertising a catalog that is not true.
	 */
	function presentsNatively(agent) {
		const modeFor = ctx.tools.modeFor;
		if (typeof modeFor !== 'function') return true;
		return modeFor.call(ctx.tools, agent) === 'native';
	}

	/** Split what this agent's registry currently holds, by group. */
	function partitionFor(agent) {
		return partition([...ctx.tools.view(agent).visible.values()], active, loadedFor(agent), keep);
	}

	const searchTool = defineTool({
		name: SEARCH_TOOL,
		description: 'Load a deferred group of tools into your tool list. Your system prompt lists the groups being held back and what each one does. Pass a group name, a few words naming the capability you need, or "all". The group\'s tools become callable from your next step onward.',
		parameters: {
			query: {
				type: 'string',
				required: true,
				description: 'A group name from the deferred-tools list, a few words naming the capability you need, or "all".',
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					loaded: {
						type: 'array',
						required: true,
						items: { type: 'string' },
					},
					tools: {
						type: 'array',
						required: true,
						items: { type: 'string' },
					},
					message: {
						type: 'string',
						required: true,
					},
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.message,
			}],
		},
		isConcurrencySafe: () => true,
		execute(args, exec) {
			const agent = exec.agent;
			if (!agent) throw new Error('tool_search requires an owning agent session');
			const loaded = loadedFor(agent);
			const { hidden } = partitionFor(agent);
			const deferred = active.filter((group) => (hidden.get(group.id)?.length ?? 0) > 0);
			if (deferred.length === 0) {
				return Promise.resolve({
					loaded: [],
					tools: [],
					message: 'Nothing is deferred: every tool you have is already listed in your tool schemas.',
				});
			}
			const matched = resolve(args.query, withSummaries(deferred, hidden));
			if (matched.length === 0) {
				return Promise.resolve({
					loaded: [],
					tools: [],
					message: `No deferred group matches ${JSON.stringify(args.query)}. Deferred groups: ${deferred.map((group) => group.id).join(', ')}. Pass one of those names, or "all".`,
				});
			}
			const names = [];
			for (const id of matched) {
				loaded.add(id);
				for (const tool of hidden.get(id) ?? []) names.push(tool.name);
			}
			return Promise.resolve({
				loaded: matched,
				tools: names,
				// Naming them costs a few hundred characters once, and buys a
				// step: the model can plan its browser (or whatever) sequence
				// now instead of spending the next step reading its own tool
				// list to find out what it just loaded.
				message: `Loaded ${matched.join(', ')} — ${names.length} tool${names.length === 1 ? '' : 's'}: ${names.join(', ')}. Their full schemas are in your tool list from your next step; call them like any other tool. Do not call tool_search again for these.`,
			});
		},
		presentCall: (args) => ({
			card: 'generic',
			title: `Load tools: ${args.query}`,
			kind: 'other',
			rawInput: args.query,
		}),
	});

	/**
	 * Register or drop `tool_search` to match the switches.
	 *
	 * With no group deferred there is nothing to load, and a tool whose
	 * only honest answer is "nothing is deferred" is a schema charged to every
	 * request for no capability at all — which is the exact cost this package
	 * exists to remove.
	 */
	function syncTool() {
		const wanted = active.length > 0;
		if (wanted === (toolDisposer !== undefined)) return;
		if (!wanted) {
			toolDisposer();
			toolDisposer = undefined;
			return;
		}
		toolDisposer = ctx.tools.register(searchTool);
	}

	/** Recompile from the live config. Called at mount and on every settings write. */
	function sync() {
		const value = readConfig(source());
		groups = compileGroups(value.groups);
		keep = value.keep.map(compilePattern);
		// One list, read two ways: an id the patch annotates compiles from the
		// authored globs and summary, and every other id is a discovered group
		// whose globs are derived from the id itself. The annotation wins the
		// collision — it is somebody's decision, against a derived guess.
		const annotated = deferredGroups(groups, value.defer);
		const claimed = new Set(groups.map((group) => group.id));
		active = [...annotated, ...compileDiscovered(value.defer.filter((id) => !claimed.has(id)))];
		syncTool();
	}

	ctx.systemPrompt.section({
		name: 'tools:deferred',
		order: CATALOG_ORDER,
		text: (context) => {
			const agent = context.agent;
			if (agent === undefined || active.length === 0 || !presentsNatively(agent)) return '';
			return renderCatalog(partitionFor(agent).hidden, active);
		},
	});

	// `assemble()` runs at every pre-step and its waterfall value is what
	// reaches the request, so a group loaded mid-turn is advertised from the
	// next step. Registered unscoped: the dispatch carrier admits a listener
	// whose context carries no scope tag, so one listener serves every agent.
	ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
		const assembled = await next();
		const agent = context.agent;
		if (agent === undefined || active.length === 0 || !presentsNatively(agent)) return assembled;
		const { visible } = partition(assembled.tools, active, loadedFor(agent), keep);
		if (visible.length === assembled.tools.length) return assembled;
		return { ...assembled, tools: visible };
	});

	// Persisted switches. The row's own config is the base layer, so the group
	// annotations — and any `defer` the patch ships as its default — stay in
	// the patch, and the user layer holds only what someone toggled.
	installSettingsSection(ctx, TOOL_DISCLOSURE_SETTINGS_NAMESPACE, Config, config ?? {}, {
		setSource: (next) => { source = next; sync(); },
		onChange: sync,
	});

	// Plugin-owned settings routes, mounted only where there is a web server to
	// serve them: a headless run has a settings namespace but no page.
	ctx.inject(['webServer'], (sctx) => {
		const webServer = sctx.get('webServer');
		const disposers = makeSettingsRoutes(ctx, () => source()).map((route) => webServer.register(route));
		sctx.effect(() => () => {
			for (const dispose of disposers) dispose();
		}, 'dsh-tool-disclosure: settings routes');
	});

	// `installSettingsSection` calls back synchronously when the settings
	// service is already present, but nothing promises it is: mount from the
	// row's own config so the surfaces are correct before any settings layer
	// arrives.
	sync();
}

export { Config, TOOL_DISCLOSURE_SETTINGS_NAMESPACE, apply, inject, name };
