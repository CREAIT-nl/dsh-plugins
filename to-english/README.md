# @creait/dsh-to-english

Rewrites a market-installed plugin's Chinese copy into English, using a model
you already have configured — once when it lands, then live-reloaded.

Most of the DSH plugin market is written in Chinese. Installing from it gives
you a working plugin whose settings page, tool descriptions, log lines and
README you cannot read. Translating by hand is a per-plugin chore that has to be
redone on every update, and a blunt "replace every CJK run" pass produces
something worse: a plugin that reads English and no longer works.

This runs the translation as a guarded pipeline. The model only ever sees line
ranges that contain Chinese, it must return the same number of lines, and every
line it returns is checked against the original before it is accepted. The
untouched original is kept beside the file as `.zh.bak`.

## What it will not translate

Three shapes are Chinese that the *program* reads, not the user, and rewriting
them deletes a feature rather than localising it. The pipeline passes them
through untouched:

**Match data.** dsh-recall's auto-recall gate is ~324 characters of Chinese
trigger phrases and Chinese regexes. Translate them and the feature never fires
again. A line holding a regex literal with CJK, or a line that is only quoted
literals and commas, is locked.

**The non-English half of an i18n table.** A `var zh = {…}` next to a
`var en = {…}` is already bilingual; rewriting `zh` serves English to the people
who deliberately picked Chinese. A brace-depth scan from a head line bound to a
non-English language tag locks the block.

**Structure.** `keepsStructure` compares the code skeleton — strings, comments
and nothing else may move. YAML gets its own gate: `dsh-enhance` ships three
Chinese comment lines directly above `- insert:`, and a reworded `id:` there is
a boot failure, so a quoted scalar is only writable if the *original* held CJK.
`prompt: "你是助手"` translates; `name: 'dsh-enhance'` does not.

One structural edit is allowed. `"请求 " + <b>{n}</b> + " 次"` puts the measure
word after the number and English puts it in front, so the trailing literal has
nothing left to hold and must go. `dropsOnlyAffixes` permits that deletion under
narrow terms — only a short CJK literal, at most two per line, exactly one
separator removed each, and only when another Chinese literal on the same line
survives, so `t("中文标题", fallback)` cannot quietly lose an argument. Every
such acceptance is logged and listed under `relaxed` in the file report.

Protocol strings have no deterministic rule. `lib/semantic.js`'s `QUERY_PREFIX`
in dsh-recall is the BGE embedding model's required instruction prefix; it is
covered by a prompt clause, not a gate. **Review the diff.**

`README.zh.md` and its siblings are skipped outright — the English README is the
file next to it, and translating it spends the budget producing a second English
README under a name that says it is Chinese. A `README.md` that is itself the
localized half (a Chinese `README.md` beside an English `README_EN.md`) is
skipped the same way.

## Install

```sh
dsh plugin --profile web add @creait/dsh-to-english
```

The package ships its own `cordis.patch.yml`, so it inserts its roster row on
its own — no manual profile edit. Add it to `dsh.profile.bundles` to activate
the browser half.

## Configure

Settings live in the `dsh-to-english` namespace, or in the GUI at
**Settings → To English**.

| Key | Default | What it does |
|---|---|---|
| `enabled` | `true` | Run automatically when a plugin is installed. |
| `provider` / `model` | `''` | Which configured model translates. Empty means the first available. |
| `prompt` | style guidance | Editable. Style only — the mechanical contract lives in `PROTOCOL_SYSTEM`, where an edited prompt cannot weaken it. |
| `rewriteRadius` | `1` | Lines without Chinese on each side of a Chinese line that are also open to rewriting. `0` leaves a mixed passage reading like a graft; `1` lets the model repair the English clause the Chinese was joined to. Capped at `5`. |
| `translateEverything` | `true` | Translate the match data and locale tables described above rather than preserving them. Preserving keeps a plugin working for a Chinese speaker; on an English-only harness it just leaves a feature switched off, since the phrases that would fire it can never be typed. The gates that stop the model editing *code* are unaffected. |

The automatic run fires on a **new** top-level package directory appearing in
the profile's `node_modules`. Anything installed before this plugin existed
never crossed that trigger — use the settings section's **Translate now** box,
which takes a package name and runs the same pipeline.

## Routes

Loopback-only, mirroring the gen-limit settings-route pattern — the harness
settings wire only exposes namespaces on its own allowlist, which a plugin
cannot widen:

| Route | Purpose |
|---|---|
| `GET/POST /api/dsh-to-english/config` | read/write the settings above |
| `GET /api/dsh-to-english/catalog` | live provider/model list |
| `POST /api/dsh-to-english/translate` | translate + reload one installed plugin now |
| `GET /api/dsh-to-english/status` | enabled, provider, model, last run |

## What breaks this

The watcher, the settings provider and the live-reload seam are pre-1.0
internal dsh surfaces with no compatibility guarantee. `peerDependencies` pins
the versions this was built against; a harness upgrade can move them.

Translation is a model call, so it is not deterministic. The gates make a bad
run *rejected* rather than *accepted quietly* — a line that fails its check is
left in Chinese and counted in the report — but they cannot make a mediocre
translation good. Read the report, and for anything carrying a protocol string,
read the diff against `.zh.bak`.

The settings nav glyph is a deliberate reach past the API. `settings.section`
has no icon option — the shell picks the glyph from a hardcoded section-id map
and falls back to the gear for ids it does not know, ours included. So the
client half repaints its own row: it finds the nav cell by label and replaces
the gear's markup with the official `IconListPenOutline16`. It fails safe — if
the shell's markup moves, nothing matches and the row keeps the gear.
