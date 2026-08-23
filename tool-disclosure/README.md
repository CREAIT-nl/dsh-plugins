# @creait/dsh-tool-disclosure

Progressive tool disclosure for DeepSeek Harness. A rarely-used group of tools
costs one line of catalog instead of its full schemas, until the model asks for
it.

## Why this exists

dsh advertises every registered tool on every request, in every mode, for the
whole session. There is no progressive disclosure anywhere in the harness: the
agent loop reassembles the system prompt at each step and hands
`assembly.tools` straight to the request builder, so a tool that is mounted is
a tool you pay for — first token to last.

Most of the time that is the right trade. `bash`, `read`, `edit`, `grep`,
`web_search` are used in the majority of sessions, and a round trip to unlock
them would cost more than their schemas ever do.

An MCP server is where it stops being the right trade. Adding the Playwright
MCP server to the host plane mounts 24 browser tools whose schemas measure
**18.5 KB of JSON**, and the input-token count of a live session moved
**18,322 → 22,765** the moment they appeared: **+4.4k tokens on every request
of every session**, including the overwhelming majority that never open a
browser.

The rule this package encodes:

> Defer a group when `schema_cost × sessions_that_never_use_it` beats
> `one_round_trip × sessions_that_do`.

bash, file, search, web, todo, skill and subagent tools lose that comparison.
A browser fleet wins it outright.

## What the model sees

Instead of 24 schemas, the system prompt carries one section:

```
Some of your tools are not listed in your tool schemas yet. Each line below is
a capability you HAVE but cannot call until you load it. Call tool_search with
a group name — or a few words naming the capability you need — and that group's
tools join your tool list from your next step onward; then call them like any
other tool. Never tell the user something is beyond you without searching here
first.
- browser (24 tools): Drive a real Chrome and act in it: open a URL, read the
  page as an accessibility snapshot, click, type, fill and submit forms, …
```

The model calls `tool_search({query: 'browser'})` — or `'I need to click a
button on a page'` — the group's tools join its list from the next step, and it
calls them normally. The catalog entry disappears once the group is loaded.

Loads are **per agent session**, held in a `WeakMap` keyed by the agent object,
so one session opening the browser does not widen anyone else's context, and
nothing has to be cleaned up when the session ends.

## Measured

One live Standard-mode session, read out of the session transcript's
`request/header` records:

| | Tools advertised | Tool schemas | Catalog |
| --- | --- | --- | --- |
| Deferred | 34 | 29,816 chars | 956 chars |
| After `tool_search('browser')` | 58 | 46,870 chars | — |

**17,054 chars (~4.1k tokens) of schema, for 956 chars (~228 tokens) of
catalog.** Net saving of roughly 3.9k tokens per request, held for as long as
the session does not need a browser — and the first turn of that session
measured 10,699 input tokens rather than the ~14.8k it would otherwise have
been.

## Install

```bash
dsh plugin --profile web add @creait/dsh-tool-disclosure
```

Then switch a group on — in **Settings → Tool Disclosure**, or in your profile
patch, which also lets you give the group a better id and a summary written by
hand:

```yaml
- insert:
    - id: tool-disclosure
      name: '@creait/dsh-tool-disclosure'
      config:
        defer: ['browser']
        groups:
          - id: browser
            match: ['mcp__playwright__*']
            summary: >-
              Drive a real Chrome and act in it: open a URL, read the page as an
              accessibility snapshot, click, type, fill and submit forms, select
              options, hover, drag, press keys, upload files, handle dialogs,
              switch tabs, resize, screenshot, read console messages and network
              requests, and run JavaScript in the page. Reach for it when a page
              needs JavaScript to render, sits behind a login, or has to be
              clicked through — web_fetch already handles a plain read.
```

Restart `dsh` — the boot manifest is assembled at startup.

Mount it on the **host plane**, unscoped. dsh dispatches the
`system-prompt/assemble` waterfall per scope, and an unscoped listener receives
every scoped dispatch, so one row covers every agent and every mode.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `defer` | `[]` | The group ids being held back. The one switch. Written by the settings page. Names, never globs — an entry carrying `*` is dropped. |
| `keep` | `[]` | Globs never deferred, even when a group's `match` claims them. |
| `groups` | `[]` | Optional annotations. Each needs `id`, `match` and `summary`. |
| `groups[].id` | — | What the model passes to `tool_search`, and what goes in `defer`. |
| `groups[].match` | — | Tool-name globs (`*` only) the group claims. First group claiming a name wins, so config order is the tiebreak. |
| `groups[].summary` | — | The **only** thing the model knows before loading. Name capabilities, not packages. |

With `defer` empty the plugin mounts nothing at all — not even its own tool
schema.

**Every tool the registry holds is already in a group**, whether or not
anything wrote one down. An MCP server's tools are bucketed under the server's
name; every other tool stands alone. So `groups` is not what creates a group —
it *annotates* one that exists either way, with a chosen id, globs of its own
and a summary in someone's words rather than a derived one. `browser` above is
`playwright` renamed and described.

That is why an unannotated group needs no `match`: its id is the MCP server
name and the globs are derived from it (`<id>` and `mcp__<id>__*`). A server
that reconnects carrying three more tools is covered by the same entry, and one
that is down at boot still defers when it returns.

`defer` in the patch is a default, not a lock: it lands as the settings **base**
layer, so the page opens with that switch on and can still turn it off.

An id is a name and not a pattern, which is why a `*` in one is dropped rather
than escaped: an unannotated group's globs are *derived* from its id, so
`defer: ['*']` would compile to a matcher claiming every tool the registry
holds — one line, and the model loses the lot. Globs belong in `match` and
`keep`, where they are read as globs.

An annotation whose `match` covers only part of the bucket its id names keeps
the id, and the rest stays advertised: the switch defers what the annotation
claims and nothing else. The settings page shows those leftovers on the same
row and counts them apart from the saving, so a partial `match` reads as what
it is rather than as a group that costs less than it does.

`keep` is for pulling one tool out of an otherwise deferred group:

```yaml
keep: ['mcp__playwright__browser_navigate']
```

### Writing a summary

This is the whole interface. The model decides whether to spend a round trip on
the strength of one line, so it should read as a list of things it could do —
"click, fill forms, read the console" — not as a description of the package
that provides them. Saying when *not* to reach for the group ("`web_fetch`
already handles a plain read") is worth the words: it stops the group being
loaded by a session that had a cheaper option.

## Settings

The settings page owns one thing — whether each group is deferred or advertised
in full — under **Settings → Tool Disclosure** (the shipped web UI labels the
first of those **设置面板**). A switch applies immediately: the next assembly, in
every live session, uses the new value. No restart.

It is **one list**, costliest first, holding every tool the registry has. There
is no separate section for the groups someone wrote down, because a group is
not created by being written down — an annotation gives one a better id and a
hand-written summary, and both kinds get the same row and the same switch.
Costliest first is the order that answers the question the page is for; config
order would answer "what did somebody write down", which nobody is here to
decide. Each row names the tools behind it, so no group is only a number.

Listing the unannotated groups is the point of listing anything. An MCP server
that was mounted and forgotten is invisible until it has a row, and a page that
showed only the hand-written half while claiming to show what the harness
carries would be the more misleading of the two.

`tool_search` itself never gets a row, and is spared even when a hand-edited
config names it. It is the only call that loads a group back: defer it and the
model loses every group at once, with nothing left that could undo it.

The page headlines what deferring currently buys, measured from the live
registry rather than from the config:

| Figure | What it counts |
| --- | --- |
| Saved per request | Characters of schema held back, at ~4.16 chars/token. |
| Tools deferred | How many tools that is, against the shared registry's total. |

It shows no "still advertised" figure. The measurement reads the **shared**
registry, and on the web surface each agent preset mounts its own copies of the
mode tools per session — a live session advertises more than any global view
can see. What is held back is exact; what remains is not knowable from here, so
the page does not guess.

Only the switch list is persisted, as `defer` in the `dsh-tool-disclosure`
settings namespace. Group annotations stay in the patch, which is what lets one
added there later take effect without being masked by a stale copy of the whole
list in the user layer; a group stores nothing but an id, which is what lets an
MCP server's tools change underneath a switch without the switch going stale. A
write posts the list in full, rebuilt from what is on screen, and compares it
against the **user** layer rather than the merged value — so editing the patch
cannot silently move a switch you set by hand.

Ids are not checked against the registry on the way in. A group exists only
while the thing behind it does, so filtering against what is connected right
now would quietly clear the switch of every MCP server that happened to be
down, and each would come back advertised. An id matching nothing defers
nothing and costs nothing.

The page talks to two plugin-owned loopback routes rather than the settings RPC,
because the harness settings wire only exposes namespaces on its own allowlist,
which a plugin cannot widen:

| Route | Purpose |
|---|---|
| `/api/dsh-tool-disclosure/config` | read/write the `defer` list |
| `/api/dsh-tool-disclosure/groups` | every group the registry holds, measured now |

Both refuse anything that is not a loopback request, so a page opened over the
network reads nothing. It says so rather than sitting on a loading line: an
unreachable route, an absent settings service and a 403 all arrive as the same
rejected fetch, and a page that rendered them as "Reading…" would be claiming a
request is still in flight when none is. The same line stays up beside figures a
later read failed to refresh, because a measurement nobody could re-take is a
number from a moment that has passed.

With every group advertised, `tool_search` unregisters itself: a tool whose
only honest answer is "nothing is deferred" is a schema charged to every request
for no capability at all, which is the exact cost this package exists to remove.

## Design notes

**It filters presentation, not the registry.** dsh has
`ctx.tools.restrict()`, and it is the wrong lever here — its own docstring says
a single resolver "feeds presentation, lookup, and dispatch", so a restricted
tool is genuinely uncallable, and it validates names against
`restrictableNames` at install time, which an MCP server registering after its
handshake cannot satisfy. This package removes tools from the assembled
request only. A deferred tool stays fully callable: if the model names one from
memory, or a hook or a subagent invokes it, it runs.

**Code Mode is left alone.** Under a `code` presentation the schemas render
into the generated SDK section of the prompt, which this row cannot filter — so
it defers nothing there and renders no catalog, rather than claiming a saving
it did not make.

**Assemblies with no agent are left alone.** They have nowhere to record a
load, so a catalog they could never act on would be a dead end.

**The catalog counts live registrations.** A group whose MCP server has not
finished its handshake renders no line, so the model is never told about a
capability that is not there yet.

**An unannotated group's summary is derived at read time, never stored.** It is
built from what the group is holding back at that assembly — the tools' short
names, or a lone tool's own first sentence. A summary written at boot and kept
would go on promising a tool the server has since dropped, which is the one
thing the catalog must not do.

## Query resolution

`tool_search` resolves, in order: the reveal-all words (`*`, `all`,
`everything`), then an exact group id, then term overlap against each group's
id and summary with stopwords and sub-3-character terms dropped, best match
first.

Loose matching is deliberate. A query that resolves to nothing costs a whole
round trip and teaches the model the catalog is unreliable; a query that loads
one group too many costs that group's schemas — which is what it would have
cost anyway had the model asked for it directly.

## Tests

```bash
node --test test/*.test.js
```

Pure logic (globs, partitioning, catalog rendering, query resolution) is tested
against plain data; wiring is driven through a stub Cordis context that
exercises the real `system-prompt/assemble` listener, the prompt section and
the tool — including per-agent isolation, the Code Mode bail-out, and a late
MCP registration.

The settings page is driven the same way: the bundle is evaluated as the loader
evaluates it, `apply` runs against stub slots so the real registration path is
under test, and a hook-faithful React stub drives what a browser cannot be made
to show — a rejected write, a switch that moves before the round trip, the switch
list rebuilt from what is rendered, and the numbers coming back from the
re-measure rather than from the optimistic flip.

## What breaks this

`system-prompt/assemble` is a pre-1.0 internal seam with no compatibility
guarantee, and this package leans on three properties of it:

- the waterfall's return value is authoritative for `assembly.tools`;
- an unscoped listener receives every scoped dispatch, which is what makes one
  host-plane row cover every agent;
- the agent loop reassembles at **every** step, which is what makes a mid-turn
  load take effect on the next one.

If any of those move, the failure is loud in the right direction — tools stop
being deferred, so sessions get wider than they need to be rather than losing a
capability. `ctx.tools.modeFor` is probed defensively for the same reason: an
absent method is read as a native presentation.

The settings nav glyph is a deliberate reach past the API. `settings.section`
has no icon option — the shell picks the glyph from a hardcoded section-id map
and falls back to the gear for ids it does not know, ours included. So the
client half repaints its own row: it finds the nav cell by label and swaps the
gear's path geometry for a wrench, mutating the attribute rather than replacing
the node so React re-renders over it without restoring the gear. The path is
hand-drawn — the shipped set has no wrench — at the stroke weight and box
footprint of its neighbours. It fails safe: if the shell's markup or the label
moves, nothing matches and the row keeps the gear.

`peerDependencies` pins the versions this was built against; a harness upgrade
can move them.

## Licence

MIT
