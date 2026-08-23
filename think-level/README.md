# @creait/dsh-think-level

A thinking level per provider **and** model for DeepSeek Harness, plus one
control to change it for the session you are in.

## Why this exists

dsh already lets you set reasoning effort — there is a dropdown next to the
model name. What it does not have is an *answer*: the dropdown is per session,
remembered nowhere, so "this model should think hard" is re-typed in every new
conversation and forgotten in every old one. Subagents never get asked at all —
they carry no model selection, so they run at whatever the provider defaults to,
which is usually not what you would have picked for the work they do.

Effort is a property of the model and the deployment, not of the conversation.
So this plugin stores it as one:

```
session selection  >  this plugin's table  >  the adapter's own default
```

A model with no row is untouched — the provider default stands exactly as it did
before the plugin was installed, and removing a row is how you go back to it.

## What you get

**A `Thinking Level` page in Settings** — the table. Pick a provider, a model
and one of the levels that model actually publishes, and it applies from the
next message, in every session, including subagents.

**A pill in the composer** — the level for *this* session, sitting immediately
left of the model select at the trailing end of the tool row. A thinking level
is a property of the model, so it belongs next to the model, not among the
access-mode and plan controls at the leading end where it reads as one of the
mode's own switches. It is the harness's own menu — same trigger, same popup,
opening upward like the others in that row — and it shows `Auto` when nothing is
pinned, labelled with the level that will actually be used, so "auto" is never a
mystery.

If the model publishes no levels the pill stays put rather than vanishing — a
control that comes and goes with the model reads as a broken plugin rather than
as a model with nothing to offer. For a route you declared by hand it also
offers to fix that in one click; see
[A model with no levels](#a-model-with-no-levels).

The pill writes through the session's own model-selection channel — the same one
the model picker uses — so the `/model` popup shows the same value instead of
disagreeing with it. There is no second, plugin-owned notion of "the session's
level" to drift out of sync.

## Install

```bash
dsh plugin --profile web add @creait/dsh-think-level
```

Restart `dsh web` afterwards: the boot manifest is built at startup.

## How it works

One listener, on `agent/request` — the waterfall the agent loop dispatches once
per step to replace the frozen call configuration, and the last seam before
`llm.prepareCall` materialises adapter defaults. At that point
`reasoningEffort === undefined` genuinely means nobody chose, rather than
"nobody has chosen yet".

The listener is **prepended**, so it runs outermost and its rewrite lands after
everything registered later — including the harness's own step-by-step
re-derivation of the session's effort. Running last is what lets it see the
final answer; filling only a hole is what keeps your own choice winning.

It is registered **untagged**, which the scope carrier admits for every agent.
That is how subagents are covered with no second code path: they reach the same
waterfall with nothing in the effort field and take the table's answer.

Before applying a row it resolves the model's published levels and drops the row
if the level is not among them. An unsupported id makes `prepareCall` throw
`UNSUPPORTED_REASONING_EFFORT` and kills the turn, so a stale row — the model was
reconfigured, the adapter changed its levels — has to cost the request nothing.
Model metadata is resolved once per model and re-resolved when the table is
edited.

### Who else writes the effort field

Filling only an empty field is what keeps your own choice winning — but three
other things were writing that field, and each one would have shadowed the table
forever by never leaving it empty.

**The model pickers.** Both shipped pickers write the model's **adapter default**
effort into the session selection whenever you change model. The pill therefore
re-applies the configured default on a **model change**, and only on a model
change: editing the level itself never triggers it, and the first render of a
session never overwrites a level that is already set, so a level you picked by
hand survives both a model switch and a page reload.

**Any third-party picker.** A community model picker may ship an effort dropdown
of its own and pin `defaultEffort` the same way on every model change. Two
controls over one session field is confusing enough by itself, but the pinning is
the real problem: a field that is always set leaves the table no hole to fill. If
yours has one, cut it — exactly one effort control should exist.

**The harness itself**, which is the one you cannot see. `selectModel` resolves
your switch through `llm.resolveCallConfig`, which materialises the adapter's own
default effort, and then saves that whole resolved selection into
`agent-default-model` — the settings section every *new* session inherits from.
So picking a model, from any picker, silently pins that model's adapter default
globally, and sessions opened afterwards arrive with the field already set.

Nobody types that value and nobody sees it, so this plugin unsets it: it watches
the `agent-default-model` namespace and removes `reasoningEffort` whenever it
reappears, leaving the provider and model alone. What you give up is the global
"remember my last effort across sessions" behaviour — which is exactly the tier
this plugin replaces with a per-model table, and one global value shadowing a
per-model table would make the table decorative. Uninstall the plugin and the
harness goes back to pinning.

### What sticks, and for how long

A session that has already sent a message derives its selection from its own
logged request header, so the level it used is the level it keeps — a later edit
to the table moves *new* sessions, not that one. Change it there and then with
the pill.

## Configuration

Stored under the `dsh-think-level` settings namespace:

```yaml
dsh-think-level:
  defaults:
    - provider: local-gpu
      model: deepseek-v4-flash
      effort: high
    - provider: openrouter
      model: gpt-5.2
      effort: low
```

`effort` is an adapter-owned id — `off` / `low` / `high` / `max` on the DeepSeek
adapter, whatever the adapter publishes elsewhere. It is not a number and not a
scale this plugin invents; the ids come from the model's own `reasoning.efforts`,
which is what both the Settings page and the pill list.

### A model with no levels

A model offers levels only if its adapter says so, and for a route you declared
by hand under `llm-pi-ai` the adapter says nothing: no `reasoningEfforts` on the
entry means `reasoning: false`, so the pill has nothing to pick and this table
has nothing to store. The old answer was "go and edit `settings.yaml`", which is
not an answer.

**So the plugin declares them for you.** The pill's menu offers *Enable thinking
levels*, and the Settings page carries the same button under the table. Either
one writes the standard five for that model:

```yaml
llm-pi-ai:
  providers:
    local-gpu:
      models:
        - id: deepseek-v4-flash
          reasoningEfforts:
            off: none
            low: low
            medium: medium
            high: high
            max: max
```

The key is the level id — `off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
`max` — and the value is the spelling to send on the wire. `off` maps to `none`
rather than to `off` because that is what "do not think" is called on the wire.
Write `false` instead of a dict for a model that cannot think at all, and omit
the field to keep whatever the installed catalog already says.

`reasoningEfforts` is not adapter-internal state: it is a field of the
`llm-pi-ai` *settings namespace*, and pi-ai re-reads that namespace on every
write. So the levels are live on the next request — no restart, no reload, and
the pill relabels itself where it stands. The Settings row turns into *Remove
levels* afterwards, which puts the model back exactly as it was, emptied
containers and all.

Two shapes exist and which one you get is pi-ai's call, not this plugin's: a
route with a `models:` list spells every model out and carries the field on the
entry, while a route the installed catalog describes carries it in
`modelOverrides[<model>]`. The declaration goes wherever the route keeps it. A
route pi-ai does not serve at all — the built-in DeepSeek adapter, anything else
registered — owns its own capability metadata, and there the button is not
offered.

Nothing here can break a route. pi-ai validates the write with its own
`assertServiceable`, so a map it cannot serve is refused *at the write*, naming
the route and the model, rather than stored and quietly disabling the provider.
And a level the deployment does not understand is a no-op, not a failure —
remove it again whenever.

The Settings page and the pill read and write this over four loopback-only
routes (`/api/dsh-think-level/config`, `/catalog`, `/efforts`, `/levels`) rather
than the settings RPC, because that wire only exposes namespaces on a hard-coded
allowlist a plugin cannot widen.

## Development

```bash
pnpm install
npm test
```

Tests cover the listener's restraint (fills only an empty field, drops an
unpublished level, never throws), the loopback guard on the routes, the two
declaration shapes and what a withdrawal cleans up, and the client bundle
rendered against a miniature React — including the model-change re-apply, which
is the part that has to be exactly right in both directions.

## License

MIT
