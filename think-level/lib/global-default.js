/**
 * Keep the harness's ONE global effort field empty, so the table can answer.
 *
 * `agent-default-model` stores the provider, the model, and — the problem — a
 * `reasoningEffort`. Nobody types that field. It is written by the harness
 * itself: `selectModel` resolves the switch through `llm.resolveCallConfig`,
 * which materializes the adapter's own default effort, and then persists the
 * whole resolved selection as the default for future Agents. So picking a model
 * — any model, from any picker — silently pins that model's adapter default
 * globally, and every session opened afterwards inherits it.
 *
 * That is fatal to this plugin as designed. The request listener fills the
 * effort only when it is `undefined`, which is what makes a session's own choice
 * win; but a session that inherits a pinned effort arrives at `agent/request`
 * with the field already set, so the table never gets its hole and never
 * applies. The pinned value is not a preference anyone expressed — it is the
 * adapter default of whichever model was picked last — so the fix is to stop
 * storing it rather than to start ignoring set efforts.
 *
 * `mutate` is the right verb: it unsets one path against the section as it
 * stands when the write reaches the front of the queue, so a concurrent
 * `saveSelection` writing a new provider/model cannot be clobbered by this, and
 * this cannot be clobbered by restating fields it never read.
 *
 * The loop guard is the read: with the field already absent there is nothing to
 * unset and the handler returns before writing, so the write it performs — which
 * re-emits the very event that called it — settles on the second pass.
 *
 * What this gives up: the global "remember my last effort across sessions"
 * behavior. That is the tier this plugin replaces with a per-provider/model
 * table, and one global value shadowing a per-model table would make the table
 * decorative. Uninstall the plugin and the harness resumes pinning.
 *
 * @module @creait/dsh-think-level/global-default
 */

/** The harness namespace holding the default model selection for new Agents. */
export const AGENT_DEFAULT_MODEL_NAMESPACE = 'agent-default-model';

/** The field this plugin owns instead. */
const PINNED_FIELD = 'reasoningEffort';

/**
 * Take the pinned effort out of the global default selection, if one is there.
 * @param settings - the settings service, or undefined on a composition without one.
 * @returns whether a write was performed.
 */
export async function unpinGlobalEffort(settings) {
	if (settings === undefined) return false;
	const descriptor = settings
		.describe({ redactSecrets: true })
		.find((candidate) => String(candidate.ns) === AGENT_DEFAULT_MODEL_NAMESPACE);
	// `user` is the raw override layer: the only layer a write can remove. An
	// effort arriving from the composition base is somebody's deployment choice
	// and is left alone.
	if (descriptor?.user?.[PINNED_FIELD] === undefined) return false;
	await settings.mutate(AGENT_DEFAULT_MODEL_NAMESPACE, [{ op: 'unset', path: [PINNED_FIELD] }]);
	return true;
}

/**
 * Unpin now, and again whenever the harness writes the namespace back.
 * @param ctx - host plugin context.
 * @param onError - optional failure sink; defaults to the context logger.
 */
export function installGlobalEffortUnpin(ctx, onError) {
	const warn = onError ?? ((error) => ctx.logger?.warn?.(
		`dsh-think-level: could not unpin the global reasoning effort: ${String(error)}`,
	));
	// Detached on purpose. This runs inside the settings emit, so awaiting it
	// here would hold a write open on the write it is reacting to.
	const run = () => { void unpinGlobalEffort(ctx.get('settings', false)).catch(warn); };
	ctx.on('settings/document-updated', (ns) => {
		if (String(ns) === AGENT_DEFAULT_MODEL_NAMESPACE) run();
	});
	run();
}
