# @creait/dsh-to-english

Rewrites a market-installed plugin's Chinese copy into English, using a model
you already have configured — once when it lands, then live-reloaded.

Most of the DSH plugin market is written in Chinese. Installing from it gives
you a working plugin whose settings page, tool descriptions, log lines and
README you cannot read. Translating by hand is a per-plugin chore that has to be
redone on every update, and a blunt "replace every CJK run" pass produces
something worse: a plugin that reads English and no longer works.

The untouched original is always kept beside the file as `.zh.bak`.

## How it translates

**One pass over the whole file is the default.** The model is handed the entire
file and returns the entire file. What stands behind it is not a diff gate but a
parser: `node --check` for `.js`/`.cjs`/`.mjs` (on a sibling temp file, so the
package's own `type` field decides script-vs-module exactly as it will at load
time), `JSON.parse` for `.json`, a YAML parse for `.yml`/`.yaml`. A file that
fails is handed back to the model with the parser's complaint, up to three
repair round-trips. A reply shorter than 60% of the original is treated as
truncated rather than as a translation — prose has no parser to catch a
half-written README.

Files up to **48 KB** go through this path. Above that the model would have to
echo back more than the completion budget allows.

**The segment path is the fallback.** For a file too large to echo back, or one
the model could never get past its parser, the older pipeline still runs: only
line ranges containing Chinese are sent, the reply must have the same number of
lines, and each line is checked against the original's code skeleton before it
is accepted. A conservative partial translation beats none at all. Nothing above
512 KB is touched at all.

Why the default moved: the skeleton comparison is safe, and it is also why
Chinese that has to change *shape* to become English never translated.
`/^[好嗯啊]*\s*继续/` has to become `/^(ok|um|ah)*\s*continue/` — a character
class turning into an alternation, because Chinese marks optionality per
character and English words are longer than one character. Every such line came
back rejected.

What that trades away is real and worth stating: **`node --check` catches a file
that stopped parsing, not one that still parses and now means something else.**
A renamed identifier, a reworded `id:` in `cordis.patch.yml`, a translated
`"main"` in `package.json` all survive their parser. The contract asks the model
to leave those alone; nothing enforces it. Read the diff against `.zh.bak`.

## What it will not translate

`translateEverything` (default `true`) decides whether Chinese the *program*
matches on is rewritten or preserved. On an English-only harness, preserving it
just leaves a feature switched off — the phrases that would fire it can never be
typed — so the default is to translate it, and to change its shape where English
demands a different one. Turn it off and the segment path locks three shapes:

**Match data.** dsh-recall's auto-recall gate is ~324 characters of Chinese
trigger phrases and Chinese regexes. A line holding a regex literal with CJK, or
a line that is only quoted literals and commas, is locked.

**The non-English half of an i18n table.** A `var zh = {…}` next to a
`var en = {…}` is already bilingual; rewriting `zh` serves English to the people
who deliberately picked Chinese. A brace-depth scan from a head line bound to a
non-English language tag locks the block.

Two things are locked regardless of that setting.

**Names the code looks up.** Variable and function names, object keys, import
and route paths, settings namespaces, and the `id`, `name` and `main` fields of
`package.json` and `cordis.patch.yml`. In the segment path `keepsStructure`
enforces this by comparing the code skeleton, and YAML gets its own gate — a
quoted scalar is writable only if the *original* held CJK, so
`prompt: "你是助手"` translates and `name: 'dsh-enhance'` does not. In the
whole-file path this is a contract clause, not a gate.

**Protocol strings.** `lib/semantic.js`'s `QUERY_PREFIX` in dsh-recall is the
BGE embedding model's required instruction prefix. It belongs to the checkpoint,
not to the user: a model trained on Chinese instructions expects its Chinese
instruction whatever language the query is in. No deterministic rule catches
this — it is a prompt clause in both paths. **Review the diff.**

`README.zh.md` and its siblings are skipped outright — the English README is the
file next to it, and translating it spends the budget producing a second English
README under a name that says it is Chinese. A `README.md` that is itself the
localized half (a Chinese `README.md` beside an English `README_EN.md`) is
skipped the same way.

### The one structural edit the segment path allows

`"请求 " + <b>{n}</b> + " 次"` puts the measure word after the number and English
puts it in front, so the trailing literal has nothing left to hold and must go.
`dropsOnlyAffixes` permits that deletion under narrow terms — only a short CJK
literal, at most two per line, exactly one separator removed each, and only when
another Chinese literal on the same line survives, so `t("中文标题", fallback)`
cannot quietly lose an argument. Every such acceptance is logged and listed
under `relaxed` in the file report.

## Install

Not on npm yet, and pnpm cannot install a subdirectory of a git repo — so
clone the repo and point the profile at the folder:

```sh
git clone https://github.com/CREAIT-nl/dsh-plugins.git
dsh plugin --profile web add ./dsh-plugins/to-english
```

That records a `link:` rather than copying the package in, which is what you
want here: pnpm does not install a link target's dependencies into the linking
project, so the profile's `node_modules` stays free of a second copy of any
`@deepseek-ai/*` runtime. Run `pnpm install` inside `to-english/` once, then
restart `dsh web` — the boot manifest is built at startup.

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
| `prompt` | style guidance | Editable. Style only — the mechanical contract lives in `WHOLE_FILE_RULES` and `PROTOCOL_SYSTEM`, where an edited prompt cannot weaken it. |
| `rewriteRadius` | `1` | Segment path only. Lines without Chinese on each side of a Chinese line that are also open to rewriting. `0` leaves a mixed passage reading like a graft; `1` lets the model repair the English clause the Chinese was joined to. Capped at `5`. |
| `translateEverything` | `true` | Translate the match data and locale tables described above rather than preserving them. The gates that stop the model renaming *code* are unaffected. |

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

Translation is a model call, so it is not deterministic. In the segment path a
line that fails its check is left in Chinese and counted in the report. In the
whole-file path a file that fails its parser three times is abandoned and falls
back to segments. Neither can make a mediocre translation good, and neither
catches a change that parses. Read the report, and for anything carrying a
protocol string, read the diff.

The settings nav glyph is a deliberate reach past the API. `settings.section`
has no icon option — the shell picks the glyph from a hardcoded section-id map
and falls back to the gear for ids it does not know, ours included. So the
client half repaints its own row: it finds the nav cell by label and replaces
the gear's markup with the official `IconListPenOutline16`. It fails safe — if
the shell's markup moves, nothing matches and the row keeps the gear.
