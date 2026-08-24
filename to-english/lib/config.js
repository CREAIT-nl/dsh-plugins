/**
 * dsh-to-english configuration: which already-configured model to use for
 * translation, whether the automatic-on-install pipeline is on, and the
 * editable translation prompt. Persisted by the dsh settings provider.
 */
import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { DEFAULT_REWRITE_RADIUS, MAX_REWRITE_RADIUS } from './translate.js';

/** Settings namespace of this capability. */
export const TO_ENGLISH_SETTINGS_NAMESPACE = settingsNamespace('dsh-to-english');

/**
 * The default translation prompt. The user can edit this in the settings UI.
 *
 * This is style guidance only. The mechanical contract — line ranges in, the
 * same number of lines out, everything non-CJK copied byte for byte — lives in
 * `PROTOCOL_SYSTEM` in translate.js, where an edited prompt cannot weaken it.
 * What is left here is the part worth a human's judgement: how the English
 * should read.
 */
export const DEFAULT_PROMPT = [
  'The text you are translating is the human-facing copy of a plugin for DeepSeek Harness (DSH): UI strings, tool descriptions, log messages, code comments, README prose, and package descriptions.',
  '',
  'Aim for a version that reads as if the plugin had been written in English by a native speaker who knows the domain — natural and idiomatic, not a word-for-word rendering of the Chinese.',
  '',
  'Keep the register of the original: a terse code comment stays terse, a user-facing warning stays direct, README prose stays explanatory. Use the established English term for harness concepts (session, profile, plugin, tool, provider, model, embedding) rather than inventing one. Where the Chinese is ambiguous, prefer the reading that matches the surrounding code.',
].join('\n');

/** Schemastery schema, validated + persisted by the dsh settings provider. */
export const Config = z.object({
  // Master switch: run the pipeline automatically when a plugin is installed.
  enabled: z.boolean().default(true),
  // Which already-configured model to use. Empty means "first available".
  provider: z.string().default(''),
  model: z.string().default(''),
  // The translation prompt, editable in settings.
  prompt: z.string().default(DEFAULT_PROMPT),
  // How many lines without Chinese on each side of a Chinese line are also
  // open to rewriting. Zero keeps the model to the Chinese itself and leaves
  // a mixed passage reading like a graft; one lets it repair the English
  // clause the Chinese was joined to. Wider than that and the margin starts
  // covering code that has nothing to do with the translation.
  rewriteRadius: z.number().default(DEFAULT_REWRITE_RADIUS),
  // Translate Chinese the program acts on — trigger phrases, keyword bags,
  // regex contents, the non-English half of a locale table — rather than
  // preserving it. Preserving keeps a plugin working for a Chinese speaker;
  // on an English-only harness it just leaves a feature switched off, since
  // the phrases that would fire it can never be typed. Default on. The gates
  // that stop the model editing code are not affected by this.
  translateEverything: z.boolean().default(true),
});

/** Schema defaults, re-read for hand-built test contexts. */
export const DEFAULT_CONFIG = {
  enabled: true,
  provider: '',
  model: '',
  prompt: DEFAULT_PROMPT,
  rewriteRadius: DEFAULT_REWRITE_RADIUS,
  translateEverything: true,
};

/** Normalize a partial config against the defaults. */
export function resolveConfig(input) {
  const value = input ?? {};
  return {
    enabled: value.enabled !== false,
    provider: typeof value.provider === 'string' ? value.provider : '',
    model: typeof value.model === 'string' ? value.model : '',
    prompt: typeof value.prompt === 'string' && value.prompt.trim() !== ''
      ? value.prompt
      : DEFAULT_PROMPT,
    rewriteRadius: Number.isFinite(Number(value.rewriteRadius))
      ? Math.min(MAX_REWRITE_RADIUS, Math.max(0, Math.floor(Number(value.rewriteRadius))))
      : DEFAULT_REWRITE_RADIUS,
    translateEverything: value.translateEverything !== false,
  };
}
