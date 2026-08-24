# @creait/dsh-research-mode

Deep research as an agent **mode** for DeepSeek Harness — a fixed, reviewed
research loop that plans, researches in adaptive parallel rounds, synthesises a
cited report and then argues with it. It exists only inside its own preset.

## Why this exists

dsh already ships every piece of a research fan-out: a workflow engine, a
subagent seam, `web_search`, and — with a fetch provider mounted — `web_fetch`.
What it does not ship is the loop.

You can ask the model to write one, with the `workflow` tool. The problem is that
a research script authored fresh on every call re-earns the same structural
mistakes on every call, and all of them are invisible from the outside: the
report still arrives, still reads well, and is quietly less than it claims.

So the loop ships here as a constant — `lib/script.js`, reviewed once — and the
model supplies parameters to it.

The design (planner → adaptive rounds driven by the researchers' own declared
gaps → synthesis → adversarial review) is ported from
[`dsh-deep-research`](https://github.com/omdsh-dev/dsh-deep-research) by
omdsh-dev (MIT), which got the structure right. Four things are fixed:

| # | Upstream | Here |
| --- | --- | --- |
| 1 | Questions still queued when the round cap hit were dropped: not researched, not counted, not mentioned. | The planner is told its budget up front, and every question the budget never reached leaves the loop **by name** — into the result, into the report's own "what this does not cover" section, and into the coverage footer. |
| 2 | Harvested leads were capped at the round width and the rest discarded, so a round where every researcher found something urgent lost most of it. | Every high-priority lead is queued. If the budget ends first it is reported as deferred, never dropped. |
| 3 | The `seen` set was rebuilt inside the round loop, so a gap three consecutive researchers reported got researched three times. | One dedup set for the whole run. |
| 4 | Supplying your own questions skipped planning entirely — no scope, no dimensions, no coverage audit. | Supplied questions are mandatory and used verbatim, and the planner does its job *on top of* them: it names the scope they imply and records what they miss. |

It is also written in English throughout, which the original is not.

## The mode

A mode is a dsh **agent preset**: a composition mounted per agent, not per
process. Choosing `Research mode` in the picker gets you an agent with

- **`deep_research`** — the loop, as one tool call
- **`web_search` + `web_fetch`** — which the loop's own child agents inherit,
  because they are spawned onto this same composition
- **file tools** — to read source material and write the report somewhere it
  survives the session
- **todo**, **ask-user**, and compaction tuned so a report-sized tool result is
  not pruned to death
- **skills** — `skill-filesystem` + `tool-skill`, over the same default roots as
  the shipped modes, so a source that only answers to a particular method can be
  written down once and reused. Only skill *descriptions* sit in context; a body
  is loaded when the agent calls the `skill` tool.

and, deliberately, **no shell**, **no `workflow` tool**, no plan mode.

Every other mode is untouched. `deep_research` is not in their tool catalog and
none of the guidance above is in their context window — which is the whole point
of shipping this as a mode rather than as a plugin that registers a tool
everywhere.

## Install

```bash
dsh plugin --profile web add @creait/dsh-research-mode
```

Restart dsh — the boot manifest is assembled at startup. The plugin copies its
preset into `<dsh home>/.agent-presets/research/`, and `Research mode` appears in
the picker.

That directory is writable and the copy is yours to edit. The installer records
what it wrote and **will not overwrite a preset you have changed**; on upgrade it
leaves your version alone and says so in the log.

### Prerequisite: a fetch provider

The preset mounts `tool-web` with `fetch: true`. dsh implements `web_fetch` in
full but ships no fetch provider, so without one every fetch call fails and the
researchers are capped at search snippets — which is worth considerably less
than being able to open the page.

[`@creait/dsh-web-fetch`](../web-fetch) is that provider:

```yaml
- id: web
  config:
    fetchProvider: local

- id: tool-web
  config:
    fetch: true

- insert:
    - id: web-fetch
      name: '@creait/dsh-web-fetch'
```

If you are knowingly running without one, set `fetch: false` in the preset.

The preset also raises `fetchMaxOutputChars` from its 200,000 default to 400,000.
`tool-web` applies that cap to the *source* before turndown converts it, not to
the markdown that comes out, so on HTML it budgets pre-cleanup bytes — most of
which the converter discards. At the default a long article reaches the
researcher as its first third, flagged truncated, and a lead gets spent chasing
the rest of a page it already had. Turndown compresses 5-10x, so the rendered
markdown still lands well under the raised cap; the cost is roughly 10k tokens
on the few pages large enough to need it. A `text/plain` body skips the
converter and can arrive at the full cap.

## The loop

```
Plan        one agent, structured output: scope, dimensions, sub-questions,
            and the planner's own declared coverage gaps
Research    up to `width` agents per round, up to `rounds` rounds. Each returns
            confirmed claims (with sources), uncertainties (with reasons), and
            gaps (with priority). High-priority gaps are queued as the next
            round's questions, behind the originals — breadth before depth.
Synthesize  one agent, given every finding and the coverage accounting, writing
            the report in `language` for `audience`
Review      one agent checking the report against its own evidence for
            fabricated citations, overclaiming, contradictions and coverage
            honesty; a second applying the critique
```

Structured output at the plan and research stages is load-bearing. A sub-agent
that returns prose has to be parsed, and a parser over model prose is where a
research pipeline quietly starts inventing things.

Every stage fails soft except the two that cannot: a dead planner and a run where
every researcher failed both raise, because there is nothing to write from. A
single failed researcher is recorded as an unanswered question and the run
continues.

## Calling it

```
deep_research({ topic: "…" })
```

| Argument | Default | Meaning |
| --- | --- | --- |
| `topic` | *required* | The question the report has to answer. The planner sees **this string and nothing else** about the conversation, so the constraints belong in it. |
| `questions` | — | Sub-questions that must be researched, used verbatim and first. The planner still audits them. |
| `rounds` | `3` | Adaptive rounds. Depth on what the research turns up. |
| `width` | `4` | Questions researched in parallel per round. Breadth. A width pinned in the composer overrides whatever the model passes. |
| `audience` | — | Who the report is for, when it changes what belongs in it. |
| `language` | `English` | Report language. |
| `review` | `true` | The adversarial pass. |

`rounds` and `width` are clamped to the preset's `maxRounds` / `maxWidth` (6 and
8), which the model cannot argue past.

## Pinning the width

Research-mode sessions get a `width` control in the composer, beside the access
mode. Leave it empty and the model picks a width per call, as above. Type a
number and that number wins — it replaces the `width` argument the model passed,
and is still clamped by `maxWidth`.

The pin exists because width is the one research parameter the model cannot
reason about. It knows how broad the topic is; it does not know anything about
the deployment. Pinning it makes the brief a deployment decision rather than a
per-call guess.

It is **not** the capacity mechanism — see [Width is not concurrency](#width-is-not-concurrency).
Pin the width to shape the report; capacity is gen-limit's job, not this one's.

The value is a deployment-wide setting, not a per-session one: it persists in
`~/.dsh/settings.yaml` under the `dsh-research-mode` namespace and applies to
every research run until changed. The tool reads it at call time, so a change
takes effect on the next call without a restart.

| | |
| --- | --- |
| Namespace | `dsh-research-mode` |
| Key | `width` — `0` means no pin |
| Route | `GET`/`POST` `/api/dsh-research-mode/config`, loopback only |

The control renders only in sessions running the `research` preset — including
on the new-session screen, as soon as Research mode is picked from the hero chip,
so the width can be set before the first message.

## Width is not concurrency

`width` is how many questions a round *takes*, not how many researchers run at
the same moment. The script hands the engine the whole round at once, and what
decides how many of them generate simultaneously is not in this plugin at all.

It is [`@creait/dsh-gen-limit`](../gen-limit), which caps concurrent generating
**sessions** per provider/model — and every subagent is its own session
(`dsh-subagent` mints a fresh `SessionId` per child), so a round of eight
researchers wants eight slots and gets however many the limit allows. The rest
**wait**: at capacity gen-limit queues a request FIFO rather than refusing it.

So any width works, at any capacity. A round of eight against a limit of three
runs three, then three, then two — slower than a machine that could take eight,
and identical in output. Width goes back to meaning what it reads like it means.

Set the limit in gen-limit's settings page, per provider and model. That is the
only place it lives:

| | |
| --- | --- |
| Namespace | `dsh-gen-limit` |
| Key | `limits[].max` — concurrent generating sessions; `-1` is unlimited |
| Also | `queueTimeoutMs` (how long a request waits before it is refused instead), `maxQueued` (how deep the line may get) |

### Why not the workflow engine's `maxConcurrentAgents`

The engine has its own per-run cap and this preset deliberately leaves it unset.
It is the wrong instrument for this:

- **It is per run.** `WorkflowExecution` is constructed per workflow run, so two
  research runs at a cap of 3 are 6 concurrent generations. It cannot express a
  machine-wide ceiling because it has never seen the other runs.
- **It cannot see your chat.** An ordinary session's turns never touch the
  workflow engine, so they are invisible to it and it to them.
- **It duplicates a number you already set.** Your deployment's capacity is
  declared once, in gen-limit. Writing it again in a preset file that ships with
  this plugin means two copies to disagree the day you change one.

Set it only if you are running research **without** gen-limit installed. Unset,
it derives from CPU count (`min(16, cores - 2)`), which measures the wrong
machine — what runs out is generation slots on the backend, not cores here.

Retry still earns its place, but for a narrower case than before. With gen-limit
queueing, a request at capacity waits instead of failing, so the retry waterfall
is no longer what keeps a wide round alive. It covers what is left: a wait that
runs out (`queueTimeoutMs`), a queue too deep to join (`maxQueued`), and the
ordinary transport failures that have nothing to do with capacity. Keep
`GEN_CAPACITY_EXCEEDED` in `retryableCodes` — it is now rare rather than routine,
and it means the backend has been saturated for a sustained period.

## The coverage block

The result carries its own audit, and it is rendered under the report rather than
left in a structured field nobody reads:

```
Researched 9 of 12 planned questions over 3 rounds at a width of 4, plus 2 follow-ups surfaced during the run.
Evidence: 41 sourced claims, 6 of them low-confidence, 8 recorded uncertainties.

Never answered (3) — the report above does not cover these:
- What does the enterprise tier actually cost at 500 seats?
- …
```

This is the part that makes the numbers honest. A report that arrives without
them reads as complete coverage of its topic, and the agent relaying it has no
way to know it is not.

## Config

Set on the `research-mode-tool` row inside the preset:

| Key | Default | Meaning |
| --- | --- | --- |
| `rounds` | `3` | Default rounds when the call names none |
| `width` | `4` | Default parallel width |
| `maxRounds` | `6` | Ceiling the model cannot exceed |
| `maxWidth` | `8` | Ceiling the model cannot exceed |
| `review` | `true` | Run the adversarial pass by default |
| `language` | `English` | Default report language |
| `toolName` | `deep_research` | Rename the tool |

## Two entry points

| Specifier | Plane | Injects | Does |
| --- | --- | --- | --- |
| `@creait/dsh-research-mode` | roster (profile bundle) | *nothing required*; reaches for `settings` and `webServer` through scoped injects | Installs the preset, registers the `dsh-research-mode` settings namespace, serves the width-pin route, and ships the composer control. Registers no tool, no prompt, no command — nothing the model can see. |
| `@creait/dsh-research-mode/tool` | agent (inside the preset) | `tools`, `workflowEngine` | Registers `deep_research`. |

They are separate modules rather than one behind a config flag because Cordis
`inject` is all-required and gates loading. The Web surface disables
`workflow-worker-thread` on the host plane and each preset mounts its own, so a
roster row declaring `workflowEngine` would wait forever for a service that
composition never publishes — and the preset would never install, so the mode
would never appear.

For the same reason the tool row must sit **inside** the group carrying
`isolate: { workflowEngine: true }`, alongside the `workflow-worker-thread` row.
The realm is entry-local and invisible to siblings outside the group.

To put `deep_research` in another mode, copy that group into its preset.

## Tests

```bash
node --test test/*.test.js
```

The loop is tested the way the engine runs it — a `node:vm` context with the same
six globals (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`) and the same
`(async () => { … })()` wrapper — with `agent` answering from a script instead of
a model. Each of the four fixes above has a test named after the flaw it pins
down, alongside the failure paths, the tool's clamping and result shaping, the
coverage renderer, and the installer's refusal to overwrite a locally edited
preset.

## Licence

MIT. The loop's design is ported from
[`dsh-deep-research`](https://github.com/omdsh-dev/dsh-deep-research) (MIT,
Copyright (c) 2026 dsh2026), with thanks. See `LICENSE` for the full
acknowledgement.
