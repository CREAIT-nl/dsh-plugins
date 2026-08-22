/**
 * Plugin configuration: the settings section the web GUI edits and the
 * per-provider/model concurrency limits the llm/stream limiter resolves on
 * every request. Persisted by the dsh settings provider.
 */
import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';

/** Settings namespace of the generation-concurrency capability. */
export const GENLIMIT_SETTINGS_NAMESPACE = settingsNamespace('dsh-gen-limit');

/** One per-provider/model concurrency limit. max === -1 means unlimited (absent rows default to -1). */
export const LimitEntry = z.object({
    provider: z.string(),
    model: z.string(),
    max: z.number().step(1),
});

/** How long a request waits for a slot before it is refused instead. */
export const DEFAULT_QUEUE_TIMEOUT_MS = 120_000;

/** How many requests may be waiting on one provider/model before the door shuts. */
export const DEFAULT_MAX_QUEUED = 64;

/** Schemastery schema, validated + persisted by the dsh settings provider. */
export const Config = z.object({
    limits: z.array(LimitEntry).default([]),
    // At capacity a request now WAITS rather than failing, but not forever: an
    // unbounded wait is a hang, and a hang is worse than the error it replaced
    // because nothing says why. When the wait runs out the old
    // GEN_CAPACITY_EXCEEDED is returned, so the ceiling on how bad this can get
    // is exactly the behaviour it replaced. 0 disables the timeout — waits
    // become unbounded, which is reasonable ONLY for a batch-only deployment
    // with nobody sitting in front of it.
    queueTimeoutMs: z.number().step(1).default(DEFAULT_QUEUE_TIMEOUT_MS),
    // Backpressure. Every waiter is a live request held in memory, so a queue
    // with no bound in front of a slow backend is a leak that presents as a
    // hang. Past this many, refuse at the door.
    maxQueued: z.number().step(1).default(DEFAULT_MAX_QUEUED),
});

/** Schema defaults, re-read for hand-built test contexts. */
export const DEFAULT_CONFIG = {
    limits: [],
    queueTimeoutMs: DEFAULT_QUEUE_TIMEOUT_MS,
    maxQueued: DEFAULT_MAX_QUEUED,
};

/**
 * A non-negative integer setting, falling back when the stored value is unusable.
 *
 * Deliberately stricter than `Number()`. `Number(null)`, `Number('')` and
 * `Number(false)` are all 0, and 0 is a MEANINGFUL value here — it disables the
 * timeout and makes every wait unbounded. Coercing an absent or malformed
 * setting into it would turn a typo into a harness that hangs, so anything that
 * is not actually a number (or a string spelling one) is treated as absent.
 * @param input - the stored value.
 * @param fallback - the default to use when it is unusable.
 * @returns a non-negative integer.
 */
function counted(input, fallback) {
    const numeric = typeof input === 'number'
        ? input
        : typeof input === 'string' && input.trim() !== ''
            ? Number(input)
            : Number.NaN;
    if (!Number.isFinite(numeric) || numeric < 0) return fallback;
    return Math.round(numeric);
}

/** Normalize a partial config against the defaults. */
export function resolveConfig(input) {
    const value = input ?? {};
    const limits = Array.isArray(value.limits) ? value.limits : [];
    return {
        limits: limits.map((entry) => ({
            provider: String(entry?.provider ?? ''),
            model: String(entry?.model ?? ''),
            max: typeof entry?.max === 'number' && Number.isFinite(entry.max) ? Math.round(entry.max) : -1,
        })),
        queueTimeoutMs: counted(value.queueTimeoutMs, DEFAULT_QUEUE_TIMEOUT_MS),
        // A zero queue would refuse everything that cannot start immediately,
        // which is the old rejecting behaviour by accident rather than by
        // choice. If someone wants that, they set `max` higher or turn the
        // limit off; they do not get it from a typo in a number field.
        maxQueued: Math.max(1, counted(value.maxQueued, DEFAULT_MAX_QUEUED)),
    };
}
