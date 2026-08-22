/**
 * The roster half's configuration: the one knob the composer control edits.
 *
 * Research width — how many questions a round researches — is a per-call
 * argument the model chooses, and that is the right default: the model has just
 * read the topic and knows how broad it needs to go. What it does not know is
 * the deployment. Hence a PIN: the model picks width from the topic, the
 * operator picks it from the box, and the operator wins.
 *
 * Width is NOT the concurrency control, and pinning it is not how an
 * over-capacity fan-out is kept alive. A round is handed to the runtime whole
 * and @creait/dsh-gen-limit holds the researchers in a FIFO queue against the
 * backend's real limit, so what runs at once is a deployment-wide setting this
 * plugin does not own. Clamping width down to it would simply research fewer
 * questions and report the rest as never answered — the failure it looks like
 * it prevents. Width buys breadth; concurrency buys time.
 *
 * `width: 0` means "auto" — the model's argument stands, then the preset row's
 * `width`. Any value >= 1 is the user saying they want that width whatever the
 * model asks for, clamped to the preset row's `maxWidth` like any other width.
 *
 * NOTE on the name: this key is `width` on the ROSTER row (the pin, 0 = auto)
 * and `width` again on the TOOL row inside the preset (the per-call default, 4).
 * They are different settings in different files. This key is also the settings
 * namespace key persisted in `settings.yaml`, which is why it is not renamed to
 * something less collision-prone: the name is part of the stored format and the
 * route's wire payload.
 *
 * The namespace is registered by the roster half (host plane, where `settings`
 * and `webServer` live) and READ by the tool half (agent plane, inside the
 * preset's realm). They share this module and nothing else — no service, no
 * injection — which keeps the roster half's "registers nothing" claim intact.
 *
 * @module @creait/dsh-research-mode/config
 */
import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';

/** Settings namespace of the research mode. */
export const RESEARCH_SETTINGS_NAMESPACE = settingsNamespace('dsh-research-mode');

/** The `width` value meaning "no pin — let the call decide". */
export const WIDTH_AUTO = 0;

/** Schemastery schema, validated + persisted by the dsh settings provider. */
export const Config = z.object({
	width: z.number().step(1).default(WIDTH_AUTO),
});

/**
 * Coerce a stored/posted width into the canonical form.
 * @param input - whatever was read off the wire or out of settings.
 * @returns a non-negative integer; {@link WIDTH_AUTO} for anything unusable.
 */
export function normalizeWidth(input) {
	const width = Number(input);
	if (!Number.isFinite(width) || width < 1) return WIDTH_AUTO;
	return Math.round(width);
}

/**
 * The pinned width, or `undefined` when the user has pinned nothing.
 * @param input - a resolved or partial config value.
 * @returns the pin, or `undefined` for auto.
 */
export function pinnedWidth(input) {
	const width = normalizeWidth(input?.width);
	return width === WIDTH_AUTO ? undefined : width;
}
