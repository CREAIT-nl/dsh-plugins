/**
 * Declaring a model's thinking levels, from here.
 *
 * A model offers levels only if its adapter says so, and for a route you
 * declared by hand under `llm-pi-ai` the adapter says nothing: no
 * `reasoningEfforts` on the entry means `reasoning: false`, which means the
 * pill has nothing to pick and this plugin's table has nothing to store. The
 * answer used to be "go edit settings.yaml", which is not an answer.
 *
 * It does not have to be. `reasoningEfforts` is not adapter-internal state — it
 * is a field of a SETTINGS NAMESPACE, `llm-pi-ai`, and pi-ai re-reads that
 * namespace on every write (`installSettingsSection` → `ensureRegistrationFacts`
 * + `ensureDirectory`). So a plugin holding the settings service can declare a
 * model's levels itself and they are live on the next request, with no restart
 * and nobody in a text editor. pi-ai's own `assertServiceable` validates the
 * write, so a map it cannot serve is refused where it is written, naming the
 * route and the model, rather than stored and quietly disabling the route.
 *
 * This module is the pure half: it reads the shape of a route and turns a
 * declaration into `settings.mutate` ops. Two shapes exist and the difference
 * is forced by pi-ai's `resolveRouteModels`:
 *
 *   - a route with a `models:` list spells every model out, and the fields go
 *     on the entry — `modelOverrides` beside a `models` list is refused;
 *   - a route the installed catalog describes carries no list, and the fields
 *     go in `modelOverrides[<model>]` — which is refused for a model the
 *     catalog does not describe.
 *
 * The ops differ in more than address. `applyPathOp` walks plain objects only,
 * so no path reaches INTO an array: patching one entry of a `models` list means
 * `set`ting the whole list, while an override is one surgical path. That also
 * decides what survives in the file — dsh-settings-file diffs leaf by leaf, so
 * the override keeps every comment around it and the whole-list `set` keeps
 * only the comments outside the list.
 */

/** pi-ai's settings namespace — the one this module writes. */
export const PI_AI_SETTINGS_NAMESPACE = 'llm-pi-ai';

/**
 * The level vocabulary, in the order pi-ai walks it.
 *
 * Repeated rather than imported because it is a *wire* agreement with the
 * namespace, not a value pi-ai exports: a level this plugin offers that pi-ai
 * does not know is refused at the write, which is the failure we want.
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * What "enable thinking levels" declares when nobody says otherwise.
 *
 * The keys are dsh level ids; the values are what dispatch sends as
 * `reasoning_effort`. Identity spellings throughout, except `off` -> `none`:
 * the id vocabulary's "do not think" is spelled `none` on the wire by vLLM and
 * by OpenAI's own newer models, so the two are deliberately not the same
 * string, and writing `off: off` is the classic hand-edit bug.
 *
 * `max` is offered because an endpoint that takes `reasoning_effort` at all
 * generally passes the value straight through to the model, and a level the
 * deployment does not understand is one edit away from gone — where a level it
 * DOES understand and was never offered is invisible.
 */
export const DEFAULT_EFFORTS = { off: 'none', low: 'low', medium: 'medium', high: 'high', max: 'max' };

/** Why a route cannot be declared into. Stable ids: the client translates them. */
export const NO_ROUTE = 'no-route';
export const UNLISTED_MODEL = 'unlisted-model';

function providersOf(section) {
	const providers = section === null || typeof section !== 'object' ? undefined : section.providers;
	return providers !== null && typeof providers === 'object' && !Array.isArray(providers) ? providers : {};
}

function profileOf(section, provider) {
	const profile = providersOf(section)[provider];
	return profile !== null && typeof profile === 'object' && !Array.isArray(profile) ? profile : undefined;
}

function listOf(profile) {
	return profile !== undefined && Array.isArray(profile.models) ? profile.models : undefined;
}

function overridesOf(profile) {
	const overrides = profile === undefined ? undefined : profile.modelOverrides;
	return overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
}

/**
 * Check a posted declaration.
 *
 * Deliberately the same rules as pi-ai's `resolveModelReasoning`, applied
 * before the write rather than after: a caller that gets one wrong should read
 * which level and why, not "the route is now unserviceable". The write is
 * validated again by pi-ai regardless — this exists so the common mistakes have
 * a good error, not to replace that check.
 * @param value - `false` for a model that cannot think, or a level -> wire map.
 * @returns `{ ok: true, efforts }` with the map rebuilt in level order, or
 *   `{ ok: false, error }` naming the offending level.
 */
export function validateEfforts(value) {
	if (value === false) return { ok: true, efforts: false };
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return { ok: false, error: 'expected a level -> wire value map, or false for a model that cannot think' };
	}
	for (const level of Object.keys(value)) {
		if (!THINKING_LEVELS.includes(level)) {
			return { ok: false, error: `unknown level "${level}"; expected one of ${THINKING_LEVELS.join(', ')}` };
		}
	}
	const efforts = {};
	for (const level of THINKING_LEVELS) {
		const wire = value[level];
		if (wire === undefined) continue;
		if (wire === null) {
			// pi-ai reads a null as "send nothing for this level", which only
			// makes sense for the level that means "do not think".
			if (level !== 'off') return { ok: false, error: `level "${level}" needs the wire value to send; only "off" may be empty` };
			efforts[level] = null;
			continue;
		}
		if (typeof wire !== 'string' || wire.length === 0) return { ok: false, error: `level "${level}" must map to a non-empty wire value` };
		efforts[level] = wire;
	}
	if (!Object.keys(efforts).some((level) => level !== 'off')) {
		return { ok: false, error: 'declare a level beyond "off", or set false for a model that cannot think' };
	}
	return { ok: true, efforts };
}

/**
 * Where this model's levels are declared, and what they say today.
 *
 * Read from the RESOLVED section (schema defaults + the plugin's composition
 * base + the user document), because that is the route pi-ai actually serves —
 * a route declared in the boot manifest is no less real than one in
 * settings.yaml, and only the resolved view has both.
 * @param resolved - the resolved `llm-pi-ai` section.
 * @param provider - the route key.
 * @param model - the model id.
 * @returns `{ shape, declared }`, or `{ shape: null, reason }` when this route
 *   is not one pi-ai serves or does not list this model.
 */
export function describeDeclaration(resolved, provider, model) {
	const profile = profileOf(resolved, provider);
	// pi-ai serves exactly the routes in its own dict. Everything else — the
	// built-in DeepSeek adapter, anything else registered — owns its own
	// capability metadata and is none of this module's business.
	if (profile === undefined) return { shape: null, reason: NO_ROUTE };
	const list = listOf(profile);
	if (list !== undefined) {
		const entry = list.find((candidate) => candidate !== null && typeof candidate === 'object' && String(candidate.id) === model);
		if (entry === undefined) return { shape: null, reason: UNLISTED_MODEL };
		return { shape: 'models', declared: entry.reasoningEfforts };
	}
	return { shape: 'overrides', declared: overridesOf(profile)[model]?.reasoningEfforts };
}

/**
 * Turn a declaration into the ops that store it.
 *
 * @param resolved - the resolved `llm-pi-ai` section (decides the shape).
 * @param user - the raw user section (decides what a write has to restate).
 * @param provider - the route key.
 * @param model - the model id.
 * @param efforts - a validated map, `false`, or `null` to drop the declaration
 *   and go back to whatever the installed catalog says.
 * @returns `{ ok: true, ops }` for `settings.mutate`, or `{ ok: false, reason }`.
 */
export function planDeclaration(resolved, user, provider, model, efforts) {
	const seen = describeDeclaration(resolved, provider, model);
	if (seen.shape === null) return { ok: false, reason: seen.reason };

	if (seen.shape === 'models') {
		// Prefer the user's own list: rewriting the resolved one would copy
		// every field the composition base contributes into settings.yaml,
		// freezing values the user never typed. Fall back to the resolved list
		// when the base is the only layer that lists this model — there is no
		// way to patch one entry of an array without restating the array.
		const mine = listOf(profileOf(user, provider));
		const has = (list) => list !== undefined && list.some((entry) => entry !== null && typeof entry === 'object' && String(entry.id) === model);
		const list = has(mine) ? mine : listOf(profileOf(resolved, provider));
		const next = list.map((entry) => {
			if (entry === null || typeof entry !== 'object' || String(entry.id) !== model) return entry;
			const copy = { ...entry };
			if (efforts === null) delete copy.reasoningEfforts;
			else copy.reasoningEfforts = efforts;
			return copy;
		});
		return { ok: true, ops: [{ op: 'set', path: ['providers', provider, 'models'], value: next }] };
	}

	const path = ['providers', provider, 'modelOverrides', model, 'reasoningEfforts'];
	if (efforts !== null) return { ok: true, ops: [{ op: 'set', path, value: efforts }] };
	// Removing: take the emptied containers with it, so undoing a declaration
	// leaves the file as it was rather than a trail of empty dicts.
	const overrides = overridesOf(profileOf(user, provider));
	const override = overrides[model];
	const siblings = override === null || typeof override !== 'object' ? [] : Object.keys(override).filter((key) => key !== 'reasoningEfforts');
	if (siblings.length > 0) return { ok: true, ops: [{ op: 'unset', path }] };
	const others = Object.keys(overrides).filter((key) => key !== model);
	return {
		ok: true,
		ops: [{
			op: 'unset',
			path: others.length > 0
				? ['providers', provider, 'modelOverrides', model]
				: ['providers', provider, 'modelOverrides'],
		}],
	};
}

