# @creait/dsh-gen-limit

Per provider/model concurrency limits for DeepSeek Harness, with a settings card.

Some backends fall over — or bill hard — when several sessions generate against
them at once. A self-hosted GPU serving one model has a real ceiling; a metered
API has a financial one. dsh has no per-model concurrency control, so a single
agent that fans out subagents can saturate either.

This caps how many sessions may generate concurrently on a given
provider/model, and refuses the overflow with an explanation the model can act
on rather than a timeout it cannot.

## How it enforces

Two gates, because one is not enough:

**1. `tools/pre-execute` — reject at spawn.** When an agent calls a subagent
spawn tool (`subagent`, `subagent_fork`) and the target provider/model is
already at capacity, the *caller* is denied outright:

> Cannot spawn another subagent: `<provider>/<model>` already has 3 generation-capable
> agents in flight (limit 3). This is temporary, not a permanent refusal: you may
> poll for a free slot by waiting a few seconds and issuing the same spawn again,
> repeating until it is admitted (a running session only has to finish for capacity
> to return). If you would rather not wait, finish the current work yourself instead.

No doomed child is launched, so the parent never sees the generic "failed before
it finished" settlement and has no idea capacity was the reason. Admitted spawns
reserve a slot, released when the child settles (`subagent/end`).

**2. `llm/stream` waterfall — hard backstop.** Every streaming model call is
capped by the number of **distinct sessions actually generating**. A session
reentering the loop is not counted twice, and a session parked waiting on a
subagent holds no stream — the child is what counts. This enforces the true
ceiling no matter how a session started, and catches anything that races past
the spawn gate.

Rejections carry the code `GEN_CAPACITY_EXCEEDED`.

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

```yaml
- id: gen-limit
  config:
    limits:
      - { provider: dgx1, model: deepseek-v4-flash, max: 2 }
      - { provider: anthropic, model: claude-opus-4, max: 1 }
```

Or edit it in the GUI: **设置面板 → 插件 → 插件配置 → Generation Concurrency**.
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

`llm/stream`, `tools/pre-execute` and `subagent/end` are pre-1.0 internal seams
with no compatibility guarantee. `peerDependencies` pins the versions this was
built against; a harness upgrade can move them.

The settings nav glyph is a deliberate reach past the API. `settings.section`
has no icon option — the shell picks the glyph from a hardcoded section-id map
(ui-settings-general `navIcon`) and falls back to the gear for ids it does not
know, ours included. So the client half repaints its own row: it finds the nav
cell by label and swaps the gear's path geometry for the official
`IconBranchOutline16` path, mutating the attribute rather than replacing the
node so React re-renders over it without restoring the gear. It fails safe — if
the shell's markup moves, nothing matches and the row keeps the gear.
