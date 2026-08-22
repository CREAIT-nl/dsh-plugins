/**
 * dsh-gen-limit: per provider/model concurrency limiter for generating
 * sessions, installed permanently (survives restarts and updates).
 *
 * Host half. Two cooperating gates enforce a per provider/model cap on
 * generation (default -1 = unlimited):
 *
 *  1. `tools/pre-execute` — REJECT AT SPAWN. When an agent invokes a subagent
 *     spawn tool (`subagent` / `subagent_fork`) while the target provider/model
 *     is already at capacity, the caller is denied immediately with a clear,
 *     actionable message ("finish the work yourself, or wait and retry"). No
 *     doomed child is launched, so the parent never sees the generic "failed
 *     before it finished" settlement. Admitted spawns reserve a slot that is
 *     released when the child settles.
 *
 *  2. `llm/stream` waterfall — HARD BACKSTOP. Every streaming model call is
 *     capped for DISTINCT sessions actually generating (a session reentering is
 *     not counted twice; a session parked waiting on a subagent holds no stream
 *     and is not counted). This enforces the true ceiling regardless of how a
 *     session started, and rejects any racer that slips past the spawn gate.
 *
 * Config is persisted through the dsh settings provider (`dsh-gen-limit`
 * namespace). The web settings card reads/writes it via a plugin-owned
 * loopback config route (the harness settings wire only exposes namespaces on
 * its own allowlist, which a plugin cannot widen) plus provider/model listing
 * from the live `llm` service.
 */
import { installSettingsSection } from '@deepseek-ai/dsh-settings';
import { CapacityTimeout, makeSlotQueue } from './queue.js';
import { Config, GENLIMIT_SETTINGS_NAMESPACE, resolveConfig } from './config.js';
import { makeSettingsRoutes } from './settings-routes.js';

/** Stable cordis plugin name. */
export const name = 'gen-limit';

/** Services required before surfaces mount. */
export const inject = [];

/** Settings namespace of this capability. */
export { GENLIMIT_SETTINGS_NAMESPACE } from './config.js';

/** Error code for a capacity rejection. */
const CAPACITY_CODE = 'GEN_CAPACITY_EXCEEDED';

/** Subagent spawn tools that should be denied early when at capacity. */
const SPAWN_TOOLS = new Set(['subagent', 'subagent_fork']);

/**
 * Why a request gave up waiting.
 *
 * This is no longer the everyday answer at capacity — the everyday answer is to
 * wait, silently, and be admitted. It is what a caller sees only after the wait
 * itself ran out, so the old advice ("wait a few seconds and try again") would
 * be telling it to redo the thing that just failed. What it needs to know
 * instead is that the backend is saturated by work that is not finishing, which
 * is a different problem from being unlucky with timing.
 *
 * @param what - the action refused, e.g. `'spawn another subagent'`.
 * @param provider - provider route.
 * @param model - model id.
 * @param max - the configured limit.
 * @param busy - how many were in flight when the wait began.
 * @returns the message.
 */
function capacityMessage(what, provider, model, max, busy) {
    return 'Cannot ' + what + ': ' + provider + '/' + model +
        ' is at its generation limit (' + busy + ' in flight, limit ' + max + ') and no slot ' +
        'freed while this request waited. Requests normally queue for a slot rather than ' +
        'failing, so reaching this means the backend has been saturated for a sustained ' +
        'period, not that you were unlucky with timing. Retrying is still reasonable, but ' +
        'prefer finishing the work in hand over adding another concurrent session, and ' +
        'consider whether the limit matches what the backend can actually serve.';
}

/**
 * Mount the limiter and its persistence/route wiring.
 * @param ctx - host plugin context.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx, config) {
    /** provider\0model -> max; built from the current source on every resolve. */
    let current = () => config ?? {};
    const resolve = () => resolveConfig(current());
    /** provider\0model -> Set<sessionId> of sessions currently generating. */
    const active = new Map();
    /** provider\0model -> number of admitted-but-not-yet-settled subagent spawns. */
    const reserved = new Map();
    let anon = 0;

    const KEY = (p, m) => p + '\u0000' + m;

    function limitsMap(limits) {
        const map = new Map();
        for (const entry of limits) map.set(KEY(entry.provider, entry.model), entry.max);
        return map;
    }

    function activeCount(key) {
        const set = active.get(key);
        return set === undefined ? 0 : set.size;
    }

    function reservedCount(key) {
        return reserved.get(key) ?? 0;
    }

    function maxFor(key) {
        const limits = limitsMap(resolve().limits);
        return limits.has(key) ? limits.get(key) : -1;
    }

    /**
     * The admission queue. It reads occupancy out of `active`/`reserved` rather
     * than keeping its own count, so there is exactly one answer to "how busy is
     * this model" and the settings UI can move the limit under a running queue.
     */
    const queue = makeSlotQueue({
        capacity: (key) => {
            const max = maxFor(key);
            if (max < 0) return { free: 0, unlimited: true };
            return { free: max - (activeCount(key) + reservedCount(key)), unlimited: false };
        },
    });

    function changeReserved(key, delta) {
        const next = Math.max(0, (reserved.get(key) ?? 0) + delta);
        if (next === 0) reserved.delete(key);
        else reserved.set(key, next);
        // A freed reservation is a freed slot; whoever is waiting should get it
        // before the next arrival does.
        if (delta < 0) queue.release(key);
    }

    /** The streaming backstop: hard cap on distinct concurrently-generating sessions. */
    const limiter = async function* (options, next) {
        const limits = limitsMap(resolve().limits);
        const max = limits.has(KEY(options.provider, options.model))
            ? limits.get(KEY(options.provider, options.model))
            : -1;
        if (max < 0) {
            yield* next();
            return;
        }
        const key = KEY(options.provider, options.model);
        const sid = options.sessionId == null
            ? '<anon>:' + (++anon)
            : String(options.sessionId);
        let set = active.get(key);
        if (!set) { set = new Set(); active.set(key, set); }
        if (set.has(sid)) {
            // Same session already generating: do not count it twice.
            yield* next();
            return;
        }
        // Wait for a slot rather than refusing one. `claim` runs at the moment
        // of admission, inside the queue's pump, so this session is counted
        // before the next waiter is considered.
        const settings = resolve();
        try {
            await queue.acquire(key, () => { set.add(sid); }, {
                timeoutMs: settings.queueTimeoutMs,
                maxQueued: settings.maxQueued,
                signal: options.signal,
                message: capacityMessage('start generating', options.provider, options.model, max, set.size),
            });
        } catch (error) {
            // Only a give-up becomes a chunk. An abort is the caller's own
            // doing and must propagate as the cancellation it is, not as a
            // capacity failure the retry policy would dutifully retry.
            if (!(error instanceof CapacityTimeout)) throw error;
            yield {
                type: 'finish',
                reason: { kind: 'error', failure: { message: String(error.message), code: CAPACITY_CODE } },
            };
            return;
        }
        try {
            yield* next();
        } finally {
            set.delete(sid);
            if (set.size === 0) active.delete(key);
            // Hand the slot on before this generator is even done unwinding.
            queue.release(key);
        }
    };
    ctx.on('llm/stream', limiter);

    // Reject subagent spawns at capacity with a clear, actionable message.
    // A reserved slot is released either when the child settles (subagent/end)
    // or when the tool pipeline itself refuses allow (so we never leak).
    ctx.on('tools/pre-execute', async (exec, next) => {
        if (!SPAWN_TOOLS.has(exec.name)) return next();
        const agent = exec.agent;
        if (agent === undefined) return next();
        const provider = agent.options?.provider;
        const model = agent.options?.model;
        if (!provider || !model) return next();
        const limits = limitsMap(resolve().limits);
        const key = KEY(provider, model);
        const max = limits.has(key) ? limits.get(key) : -1;
        if (max < 0) return next();
        const busy = activeCount(key) + reservedCount(key);
        const settings = resolve();
        try {
            // The stream limiter waits, so this must wait too. Left denying, a
            // spawn would be the only path that still loses work at capacity —
            // and the spawn is the expensive thing to have to redo.
            await queue.acquire(key, () => { changeReserved(key, 1); }, {
                timeoutMs: settings.queueTimeoutMs,
                maxQueued: settings.maxQueued,
                signal: exec.signal,
                message: capacityMessage('spawn another subagent', provider, model, max, busy),
            });
        } catch (error) {
            if (!(error instanceof CapacityTimeout)) throw error;
            return { kind: 'deny', reason: String(error.message) };
        }
        const decision = await next();
        if (decision.kind !== 'allow') changeReserved(key, -1);
        return decision;
    });

    // Release a reserved slot when a published child settles. `agents` is read
    // as an optional service (not injected): it is required for precise release,
    // but its absence must never block settlement or break the hard backstop.
    ctx.on('subagent/end', (info) => {
        try {
            const agents = ctx.get('agents');
            const child = agents?.get?.(info.id);
            const provider = child?.options?.provider;
            const model = child?.options?.model;
            if (provider && model) changeReserved(KEY(provider, model), -1);
        } catch {
            /* best-effort release; never break settlement */
        }
    });

    let onStats = () => [];
    const sync = () => {
        // Nothing re-registerable here; the gates read `resolve()` live and the
        // route reads `active`/`reserved` live. But raising a limit in the UI
        // should free the requests already waiting on the old one, not just the
        // next arrivals — so the lines get re-pumped against the new numbers.
        queue.refresh();
    };

    installSettingsSection(ctx, GENLIMIT_SETTINGS_NAMESPACE, Config, config ?? {}, {
        setSource: (source) => { current = source; sync(); },
        onChange: sync,
    });

    // Plugin-owned config route (settings card read/write + provider/model
    // listing + live active counts). Registered through scoped-inject so it
    // is present only when the webserver is available (headless mounts no-op).
    ctx.inject(['webServer'], (sctx) => {
        const webServer = sctx.get('webServer');
        const disposers = makeSettingsRoutes(ctx, () => resolve(), () => active, getLlm(ctx), queue).map((route) => webServer.register(route));
        sctx.effect(() => () => {
            for (const dispose of disposers) dispose();
        }, 'dsh-gen-limit: config routes');
    });
}

function getLlm(ctx) {
    return ctx.get('llm');
}
