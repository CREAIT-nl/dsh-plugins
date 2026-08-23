/**
 * The plugin's configuration: one table, `provider + model -> reasoning effort`.
 *
 * The harness already has an effort control — a dropdown next to the model
 * name, per session, remembered nowhere. What it has never had is an ANSWER to
 * "what should this model think at", which is a property of the model and the
 * deployment, not of the conversation. A table is that answer: written once,
 * applied to every session and every subagent that lands on the row's model.
 *
 * A row is `{ provider, model, effort }`. `effort` is an adapter-owned id
 * (`off` / `low` / `high` / `max` on the DeepSeek adapter; whatever the adapter
 * publishes elsewhere), NOT a number and NOT a scale this plugin invents — the
 * ids come from the model's own `reasoning.efforts`, and one the model does not
 * publish is dropped rather than sent, because `llm.prepareCall` rejects an
 * unsupported effort and the request would die instead of thinking less.
 *
 * No row means no opinion: the adapter's own default stands, exactly as before
 * this plugin was installed. Removing a row is therefore the way back to
 * provider-default, and is why the table has no "auto" value of its own.
 *
 * @module @creait/dsh-think-level/config
 */
import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';

/** Settings namespace of this capability. */
export const THINK_LEVEL_SETTINGS_NAMESPACE = settingsNamespace('dsh-think-level');

/** One row of the table: this provider's this model thinks at this effort. */
export const DefaultEntry = z.object({
	provider: z.string(),
	model: z.string(),
	effort: z.string(),
});

/** Schemastery schema, validated + persisted by the dsh settings provider. */
export const Config = z.object({
	defaults: z.array(DefaultEntry).default([]),
});

/** The empty table — no opinion about any model. */
export const DEFAULT_CONFIG = { defaults: [] };

/** Table key. Two fields, one string; NUL because no id may contain it. */
export function keyOf(provider, model) {
	return provider + '\u0000' + model;
}

/**
 * Normalize whatever was read off the wire or out of settings.
 *
 * Rows missing any of the three fields are DROPPED rather than repaired: a row
 * with an empty model would key on the empty string and quietly apply to
 * nothing, which looks identical to a row that works until you wonder why the
 * model is not thinking. Later rows win over earlier ones for the same key, so
 * a duplicated pair reads as the last edit rather than as whichever the lookup
 * happened to see first.
 * @param input - a resolved or partial config value.
 * @returns a config with a de-duplicated, fully-populated `defaults`.
 */
export function resolveConfig(input) {
	const rows = Array.isArray(input?.defaults) ? input.defaults : [];
	const byKey = new Map();
	for (const row of rows) {
		if (typeof row !== 'object' || row === null) continue;
		const provider = String(row.provider ?? '');
		const model = String(row.model ?? '');
		const effort = String(row.effort ?? '');
		if (provider === '' || model === '' || effort === '') continue;
		byKey.set(keyOf(provider, model), { provider, model, effort });
	}
	return { defaults: [...byKey.values()] };
}

/**
 * The configured effort for one route.
 * @param config - a resolved config.
 * @param provider - provider route.
 * @param model - exact model id.
 * @returns the effort id, or `undefined` when the table has no opinion.
 */
export function effortFor(config, provider, model) {
	const key = keyOf(provider, model);
	for (const row of config.defaults) if (keyOf(row.provider, row.model) === key) return row.effort;
	return undefined;
}
