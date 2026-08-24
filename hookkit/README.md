# @creait/dsh-hookkit

Config-driven lifecycle hooks for DeepSeek Harness — **including context injection**.

dsh has no declarative hook layer of its own. The seams exist (`agent/pre-step`,
`tools/pre-execute`, `tools/post-execute`, the session event stream) but reaching
them means shipping a plugin. This turns them into YAML.

## Why not one of the existing hook plugins

| | `dsh-hooks` | `dsh-plugin-hooks` | **hookkit** |
|---|---|---|---|
| declare in `cordis.patch.yml` | ✅ | partly | ✅ |
| block a tool call | ❌ fire-and-forget | ✅ | ✅ |
| **contribute model-visible context** | ❌ | ❌ | ✅ |
| call an in-harness tool (MCP included) | ❌ | ❌ | ✅ |
| shell handler, JSON on stdin | ✅ | ✅ | ✅ |

The third row is the one that matters for memory. A shell hook is out-of-process,
so it can observe and veto but cannot hand text back to the model. Recall needs
exactly that.

The fourth row is how mem0 stays on MCP: `do.tool` calls a registered tool
in-process, so there is no second process and no second MCP handshake per turn.

## Install

```sh
dsh plugin --profile web add @creait/dsh-hookkit
```

That mounts the engine with no hooks, which costs nothing on any seam: `apply`
returns before it registers a listener while the list is empty. Declaring the
hooks is the whole of the configuration, and it happens on the row, in your
profile patch — `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, where
`$DSH_HOME` defaults to `~/.dsh`:

```yaml
- id: hookkit
  config:
    hooks: [...]
```

Restart `dsh` — the boot manifest is assembled at startup.

If you installed this before it shipped a bundle patch, your profile patch
inserts the row by hand. Drop that `- insert:` block: `insert` appends
unconditionally, so the hand-written row and the bundle's would both mount and
every hook would fire twice.

## Anatomy of a hook

```yaml
- id: mem0-recall           # unique; used in logs and deny reasons
  on: agent/pre-step        # when it fires
  enabled: true
  when:                     # filters — all must pass
    firstStep: true         # only step 1 of a turn
    hasUserMessage: true    # only when a fresh user message is present
    firstTurn: true         # only the session's first user turn (pre-step only)
    tools: ['bash', 'mcp__*']   # globs, tool events only
    match: { tool: '^git ' }    # field -> regex
    reason: [completed]     # turn/end reason kinds
  do:                       # exactly one handler
    tool: mcp__mem0__search_memory
    arguments: { query: '{{userText}}' }
  inject:                   # what happens to the output
    as: context             # context | deny | none
    template: "<memories>\n{{output}}\n</memories>"
    maxChars: 1200
    skipIfEmpty: true
    summary: 'mem0 recall'  # shown in the transcript instead of the payload
  timeoutMs: 8000
  failOpen: true            # a handler error never breaks the turn
```

### Handlers (`do:` — exactly one)

- **`tool:`** + `arguments:` — invoke a registered tool in-process. Runs through
  the normal tool pipeline, so guards and approval policy still apply: a hook is
  a privileged caller, not a bypass.
- **`run:`** — spawn a shell command. The payload arrives as JSON on stdin and as
  `DSH_HOOK_*` environment variables, plus `CLAUDE_PROJECT_DIR`. Exit 0 = allow,
  non-zero = deny. A Claude Code hook script works unmodified.
- **`http:`** — POST the payload to a URL. 2xx = allow.

### Outcomes (`inject.as`)

- **`context`** — the output becomes a model-visible message. Only
  `agent/pre-step` and `tools/post-execute` support it.
- **`deny`** — a failing handler blocks the call. Only `tools/pre-execute`
  supports it; the handler's stdout becomes the reason the model sees.
- **`none`** — fire and forget.

Declaring an outcome the event cannot deliver is a **startup error** naming the
hook, not a silent no-op.

### Events

| Event | Can inject | Can deny | Notes |
|---|---|---|---|
| `agent/pre-step` | ✅ | — | once per step; `firstStep` makes it once per turn, `firstTurn` once per session |
| `tools/pre-execute` | — | ✅ | runs before the tool |
| `tools/post-execute` | ✅ | — | context attaches to the next request |
| `turn/start` `turn/end` `step/start` `step/end` | — | — | observe-only, not awaited |
| `tool/call` `tool/result` | — | — | observe-only |
| `compaction/start` `compaction/summary` `compaction/end` | — | — | observe-only; `summary` carries the distillation |
| `user/message` `approval/asked` | — | — | observe-only |

An observe-only event still *acts* — it just cannot hand text back to the model.
`do.tool` works on all of them, which is how the memory **write** below happens
without a nudge.

### Template variables

`{{output}}` (handler output), `{{userText}}`, `{{conversationTail}}`,
`{{userTurn}}`, `{{sessionId}}`, `{{cwd}}`, `{{tool}}`, `{{toolArgs}}`,
`{{callId}}`, `{{compactionId}}`, `{{event}}`, `{{step}}`, `{{turn}}`,
`{{reason}}`, `{{content}}`, `{{timestamp}}`. Unknown names render empty.

`{{content}}` is whatever text the event is *about*, and only some events carry
any: the summary on `compaction/summary`, the message on `user/message`, the
result text on `tool/result`, the tool output on `tools/post-execute`. Elsewhere
it is empty. `{{reason}}` is the kind alone — `completed`, `blocked`,
`max-tokens`, `aborted`, `error` on `turn/end` — so `when: { reason: [error] }`
names it directly.

A `user/message` event is not only a human prompt: injected context, goal
continuations, and the replacement that lands right after a compaction all
arrive as one. A hook that must act on human input only should read
`{{userText}}`, which filters to user-authored messages, rather than hooking
the event.

`{{userText}}` reads the last **user-authored** message, so an injected block can
never feed the next turn's query with its own output.

`{{conversationTail}}` (`agent/pre-step` only) pairs that with the assistant turn
before it:

```
ASSISTANT: <first 600 chars>
[...]
<last 300 chars>

USER: ok do it
```

`{{userText}}` alone is a poor recall query for the commonest kind of turn — "ok
do it" names none of the nouns the thing to do was named with, so it retrieves
whatever the store happens to score highest. Passing the whole assistant turn is
worse: long prose embeds to a centroid that matches nothing in particular. Head
plus tail keeps what the turn was about and what it concluded and drops the
transcript in between. It reads the session's full derived history, so it works
on a step whose own claimed messages carry only a tool result.

Plugin-level, both budgets are configurable; set either to `0` to drop that half:

```yaml
config:
  conversationTail: { assistantHead: 600, assistantTail: 300 }
  hooks: [...]
```

## Recipes

**mem0 recall, once per turn, over MCP:**

```yaml
- id: mem0-recall
  on: agent/pre-step
  when: { firstStep: true, hasUserMessage: true }
  do:
    tool: mcp__mem0__search_memory
    arguments: { query: '{{conversationTail}}' }
  inject:
    as: context
    template: |
      <memories source="mem0">
      {{output}}
      </memories>
    maxChars: 2500
    summary: 'mem0 recall'
```

Pass `{{conversationTail}}` rather than `{{userText}}` to anything that has to
work out what the turn is *about*: it is the difference between recalling for
"ok do it" and recalling for the thing being agreed to.

**Prime once, then let the model ask:**

```yaml
- id: mem0-prime
  on: agent/pre-step
  when: { firstStep: true, firstTurn: true }
  do:
    tool: mcp__mem0__search_memory
    arguments: { query: '{{conversationTail}}' }
  inject:
    as: context
    skipIfEmpty: false        # the instruction has to land even on no hits
    template: |
      Memory is searched automatically only on this first turn. Call
      mcp__mem0__search_memory yourself whenever the task turns to prior work,
      and mcp__mem0__get_memory with a record's id to read a clipped one whole.
      <memories source="mem0">
      {{output}}
      </memories>
    maxChars: 2500
    summary: 'mem0 recall'
```

Two details earn their keep here. `skipIfEmpty: false` keeps the instruction
even when the first turn matches nothing, which is the turn most likely to.
And the instruction sits *above* `{{output}}` because `maxChars` clips the
rendered block from the end — put it last and a long recall would eat it.

The trade is real: recall stops being deterministic after turn one. The model
has to notice that a turn wants memory, and sometimes it won't. `firstTurn`
buys one search per session instead of one per turn; leaving it off buys
recall on "ok do it" for the price of a search every turn.

**mem0 write, when the context is about to be lost:**

```yaml
- id: mem0-persist-on-compaction
  on: compaction/summary
  do:
    tool: mcp__mem0__add_memories
    arguments: { text: '{{content}}' }
  inject: { as: none }
```

Recall without a write path is a store that only ever shrinks in usefulness, and
a hook cannot make the model save anything — `add_memories` is a tool call, and
only the model issues those. So write from the harness instead, at the one moment
the harness knows something is being discarded.

`compaction/summary` is the right seam rather than `compaction/start` for two
reasons. It carries the summary the compactor just wrote — an LLM distillation
of exactly the span being dropped, so the write costs no second model call and
needs no transcript scraping. And it fires *after* summarization but before the
surface is replaced, so the text is complete when the hook sees it.

One write per compaction, fire-and-forget, `failOpen` by default: an unreachable
mem0 costs the memory, never the compaction. What it does not cover is the
session that never compacts, which is most of them — for those the model still
has to volunteer the call, so say so in the recall primer's instruction.

**Block edits to a protected path:**

```yaml
- id: protect-vault
  on: tools/pre-execute
  when: { tools: ['edit', 'write'], match: { toolArgs: 'my-vault' } }
  do: { run: 'echo "this path is owned by a sync daemon — do not write to it directly"; exit 1' }
  inject: { as: deny }
```

**Notify on a failed turn:**

```yaml
- id: notify-failure
  on: turn/end
  when: { reason: [error] }
  do: { http: 'http://localhost:7300/notify' }
  inject: { as: none }
```

## Behaviour notes

- Hooks on one event run **concurrently**; one slow webhook cannot delay a recall.
- A handler failure is contained per hook. With `failOpen: true` (the default) the
  turn proceeds untouched — an unreachable mem0 degrades to no recall, never to a
  broken session.
- Session-stream hooks are not awaited by the agent loop.
- Injected text is clipped to `maxChars` and the cut is marked, so a truncated
  record is never mistaken for a whole one.
- Hook handlers are **trusted host configuration**, exactly like Claude Code
  hooks: they run with the harness's authority. Only enable them in a profile you
  control.

## Develop

```sh
npm test     # node --test, no dependencies
```

`lib/config.js` is pure (schema, filtering, templating); `lib/handlers.js` owns
the three handler kinds; `lib/index.js` owns the Cordis wiring.
