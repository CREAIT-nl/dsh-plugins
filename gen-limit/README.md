# @creait/dsh-gen-limit

Per provider/model concurrency limits for DeepSeek Harness, with a settings card.

Some backends fall over — or bill hard — when several sessions generate against
them at once. A self-hosted GPU serving one model has a real ceiling; a metered
API has a financial one. dsh has no per-model concurrency control, so a single
agent that fans out subagents can saturate either.

This caps how many sessions may generate concurrently on a given
provider/model. Work past the cap **waits in a FIFO queue** rather than failing:
a fan-out of eight researchers against a limit of three is a pacing problem, and
bouncing five of them does not make the brief smaller, it just spends the retry
budget re-asking.

## How it enforces

**The count — `llm/stream` waterfall.** Every streaming model call is capped by
the number of **distinct sessions actually generating**. A session reentering
the loop is not counted twice, and a session parked waiting on a subagent holds
no stream — the child is what counts. This is where the limit is enforced, and
it is enforced the same way no matter how a session started: a subagent from a
tool call, a child the workflow engine started directly, or a plain
conversation.

**The pacing — `tools/pre-execute`.** When an agent calls a subagent spawn tool
(`subagent`, `subagent_fork`) and the target provider/model is already full, the
spawn joins the same queue and is admitted as soon as there is room, so a
fan-out is paced instead of piling more sessions onto a saturated backend.

This gate deliberately holds **no slot of its own**. Reserving one per admitted
spawn is the obvious design and it double-counts: the child then takes a second
slot the instant it generates, so every live child costs two. There is no clean
seam to hand a reservation over either — `subagent/start` carries no
back-reference to the spawn that caused it, and it also fires for children the
workflow engine starts without any tool call. So a child is counted exactly
once, where it can be counted consistently.

**What a wait costs.** `queueTimeoutMs` bounds how long a request waits (`0`
waits indefinitely) and `maxQueued` bounds how many may wait at once — an
unbounded queue in front of a slow backend is a memory leak that presents as a
hang. Only a request that exhausts its wait fails, and it fails with the code
`GEN_CAPACITY_EXCEEDED`; for a spawn that means the tool call is denied.
Reaching that point means the backend has been saturated for a sustained
period, not that a request was unlucky with timing.

**The consequence — transport timeouts.** Waiting for a slot means a stream may
legitimately go quiet for a long time, so the limiter also makes sure the socket
agrees. `llm-pi-ai` lets a provider declare `streamIdleTimeoutMs`, but the SSE
stream rides Node's built-in `fetch`, whose `bodyTimeout` defaults to five
minutes and which nothing in the harness configures — so any value above
300000ms is unreachable. Raising it just moves the kill from the harness
watchdog (`TIMEOUT`) to undici (`TypeError: terminated`, classified `TRANSPORT`,
equally retryable), and each retry restarts the step from scratch and discards
everything it had generated.

So `transport.js` reads the timeout **the provider already declares** and
installs a dispatcher that applies it to that provider's origin, plus a
30-second margin so the harness watchdog stays the one that reports a dead
stream. There is nothing new to configure, and no other origin is affected — MCP
servers, web fetches and the update check keep Node's defaults. A provider that
declares no `streamIdleTimeoutMs`, or one under five minutes, is left alone.

## Install

```sh
dsh plugin --profile web add @creait/dsh-gen-limit
```

The package ships its own `cordis.patch.yml`, so it inserts its roster row on
its own — no manual profile edit. Add it to `dsh.profile.bundles` to activate
the browser half.

## Configure

Limits live in the `dsh-gen-limit` settings namespace, one row per
provider/model. **`max: -1` means unlimited, and any pair without a row defaults
to unlimited** — the plugin is inert until you give it a limit.

Seed them from the row in your profile patch — `provider` and `model` are
whatever ids your own routes publish:

```yaml
- id: gen-limit
  config:
    limits:
      - { provider: local-gpu, model: deepseek-v4-flash, max: 2 }
      - { provider: anthropic, model: claude-opus-4, max: 1 }
    queueTimeoutMs: 120000   # how long a request waits for a slot; 0 = forever
    maxQueued: 64            # how many may wait at once
```

Or edit it in the GUI: **Settings → Plugins → Plugin config → Generation
Concurrency** (the shipped web UI labels those **设置面板 → 插件 → 插件配置**).
The card lists the live providers and models from the same `llm` service the
conversation uses, so the rows are pickable rather than typed from memory.

## Routes

The card talks to three plugin-owned loopback routes rather than the settings
RPC — the harness settings wire only exposes namespaces on its own allowlist,
which a plugin cannot widen:

| Route | Purpose |
|---|---|
| `/api/dsh-gen-limit/config` | read/write the limit rows |
| `/api/dsh-gen-limit/catalog` | live provider/model list |
| `/api/dsh-gen-limit/stats` | what is generating right now |

## What breaks this

`llm/stream` and `tools/pre-execute` are pre-1.0 internal seams with no
compatibility guarantee. `peerDependencies` pins the versions this was
built against; a harness upgrade can move them.

The transport half rests on the seam Node leaves for proxies: built-in `fetch`
takes no per-call timeout options and reads its dispatcher from a global that
`undici`'s `setGlobalDispatcher` writes. Verified on Node 25.8.1 with undici
8.10.0 — a 3s `bodyTimeout` installed this way killed a built-in `fetch` body at
3.5s, where the default had taken 301s. It is a convention, not a contract; a
runtime that stopped honouring it would put the five-minute ceiling back, which
is where things stood before this existed.

The settings nav glyph is a deliberate reach past the API. `settings.section`
has no icon option — the shell picks the glyph from a hardcoded section-id map
(ui-settings-general `navIcon`) and falls back to the gear for ids it does not
know, ours included. So the client half repaints its own row: it finds the nav
cell by label and swaps the gear's path geometry for the official
`IconBranchOutline16` path, mutating the attribute rather than replacing the
node so React re-renders over it without restoring the gear. It fails safe — if
the shell's markup moves, nothing matches and the row keeps the gear.
