# Handoff: dsh-plugins — Stand nach der Nachtaktion (ca. 07:15 Uhr)

## Nacht-Ergebnis in einem Satz

Alle 8 Plugin-Pakete durchlaufen Zyklen aus Testen + Code-Review:
**Testsuite 621/7 (Basis) → 716/0 (Endstand), null offene Bugs,
alle Fixes lokal und uncommitted.** Details: `NIGHTLOG.md` (Zyklen 1–16).

## Was die Nacht verändert hat (Fixes, alle lokal, NICHT committed)

| Datei | Fix | Warum |
|---|---|---|
| `to-english/test/translate.test.js` | Pfad-Asserts über `path.sep` normalisiert | CRLF/`\`-Unterschiede auf Windows |
| `research-mode/test/wiring.test.js` | `read()` mit EOL-Normalisierung | `autocrlf=true` machte Datei-Vergleiche kaputt |
| `research-mode/test/preset-install.test.js` | chmod-Test auf win32 geskippt (Begründung im Code) | POSIX-Chmod-Semantik existiert auf Windows nicht |
| `scripts/publish-changed.mjs` | `winShell`-Spawn-Hilfe (joined command line) | `.cmd`-Shims brauchen `shell:true`, ohne DEP0190-Warnung |
| Checkout-`node_modules` | Junctions (`chokidar`, `@deepseek-ai/dsh-tools`) + entpacktes `undici`-Tarball v8.10.0 | fehlende Deps ließen 7 Tests gar nicht erst laufen |

## Review-Coverage (Nacht)

Vollständig reviewt auf einzigartiger Logikebene: **web-fetch** (addr.js SSRF-
Blockliste inkl. IPv4-mapped/NAT64-Entpackung, pro-Hop-Revalidierung bei
Redirects, DNS-Antworten werden klassifiziert — live in diesem Harness!),
**research-mode** (Workflow-Kern script.js: Budget-Buchhaltung, globale
Dedup, Deferred-Nennung — alles korrekt umgesetzt), **gen-limit**
(Slot-Queue thundering-herd-fest, Zwei-Tor-Zählung ohne Doppelzählung),
**to-english** (translateFile/Batch/Package + wholefile.js Reparatur-Schleife),
**think-level** (pi-ai-levels Op-Planung, global-default Unpin mit
Schleifenwächter), plus alle Config-/Schema-Module.

Dokumentierte Randfälle (bewusst NICHT gefixt, Upstream-Themen):
1. web-fetch: DNS-Rebinding-TOCTOU-Fenster (im Header ehrlich benannt;
   Fix = eigener undici-Dispatcher mit Connect-Revalidierung).
2. research-mode preset-install: Hash über rohe Bytes — nur bei einem
   EOL-*Wechsel* des Checkouts zwischen Versionen würde eine unveränderte
   Preset fälschlich als „local edits" gelten.
3. hookkit `abridge()` ignoriert ELISION-Marker-Länge an der Schwelle
   (kosmetisch, getestet so).
4. to-english `translatePackage`: `cjkRemaining` summiert bei Abbruch nur die
   verarbeiteten Dateien ohne Flag — Reporting-Nuance, kein Bug.

## Morgen-To-dos

1. **pnpm dauerhaft reparieren** (nur Workaround aktiv): Maschine kann sich
   nicht selbst auf das vom Repo gepinnte pnpm@11.22.0 umschalten
   (`...\store\v11\links\@\pnpm\11.22.0\<hash>\node_modules\pnpm\bin\pnpm.mjs`
   fehlt; Cache-Löschen heilt nicht). Entweder pnpm neu installieren oder
   `corepack enable && corepack prepare pnpm@11.22.0 --activate`. Bis dahin:
   für publish-changed-Läufe PATH mit `%TEMP%\night\bin` voranstellen.
2. **Entscheiden über Upstream-PRs** (alles Windows-Portabilität, gut
   begründbar): publish-changed winShell-Spawn, translate.test sep-Fix,
   wiring read-EOL, preset-install win32-Skip. Optional als Diskussionen:
   watcher RETRY_MS/onAddDir-Guards (siehe NIGHTLOG Zyklus 8).
3. **Nichts committen** — alle Änderungen liegen als Working-Tree-Diffs vor;
   Nutzer entscheidet über Commit/PR.

## Fester Stand (unverändert gültig)

| Punkt | Status |
|---|---|
| Testsuite | ✅ **716 pass / 0 fail** (gen-limit 103, hookkit 67, research-mode 148, think-level 83, to-english 109, tool-disclosure 138, web-fetch 28, searxng 40) |
| CI-Skript | ✅ `node scripts/publish-changed.mjs --dry-run` exit 0 |
| web-fetch Install | ✅ `link:C:/Users/Admin/dsh-plugins/web-fetch`, live bewiesen (echter Fetch liefert Inhalte) |
| Patch-Rows | ✅ `cordis.patch.yml`: tool-web(fetch:true) + xmanrui-dsh-im(language: en); Dump exit 0, 145 ids, keine Duplikate |
| npm-Registry | ❌ @creait/* weiterhin NICHT veröffentlicht → lokale Checkouts |

## Rollback / Pfade (unverändert aus dem Vormittag)

- Profil: `%USERPROFILE%\.dsh\profiles\desktop` · Patch-Backup:
  `cordis.patch.yml.bak-prewebfetch`
- Desktop-CLI: `C:\Users\Admin\AppData\Roaming\DSH Desktop\host-commands\desktop\bin\dsh.cmd`
  (`--profile desktop --dump-config` = Trockentest ohne Neustart)
- Plugin-Checkout: `C:\Users\Admin\dsh-plugins` · Nachtdokumentation:
  `NIGHTLOG.md` · Testlogs: `%TEMP%\night\gate*-*.log`

## Offene Themen (aus der Analyse, weiterhin offen)

- BrowserOS Neo per MCP anbinden (docs.browseros.com/neo/mcp) +
  `tool-disclosure` für Token-Ersparnis; Arbeitsteilung web_fetch ↔ Neo.
- Telegram-Bot: erster Nachricht + Whitelist noch vom Nutzer zu setzen
  (sonst schweigendes Verwerfen); danach `/sessionlist` → `/session <ID>`.

## Commits & PR (Status)

- 5 Commits auf `main` (4 Code-Fixes + diese Doku).
- Push auf `CREAIT-nl/dsh-plugins` verweigert (`rolarocka` = nur Leserecht, 403).
- Fork: **https://github.com/rolarocka/dsh-plugins** (alle 5 Commits).
- **Alle Commits auf Fork-`main` konsolidiert** (Branch `fix/windows-portability`
  gelöscht). PR an Upstream aus `main` (alle 6 Commits inkl. Doku):
  **https://github.com/CREAIT-nl/dsh-plugins/pull/6**
  (#5 wurde geschlossen/ersetzt).
- **pnpm dauerhaft repariert:** corepack 0.35.0 extrahierte pnpm@11.22.0 nicht
  (leerer Link). Per `npm install pnpm@11.22.0 --prefix <corepack-link>`
  befüllt; `pnpm --version` im Repo liefert jetzt 11.22.0. Workaround-Shim
  `%TEMP%\night\bin` nicht mehr nötig.
- Upstream `main` unverändert → wartet auf CREAIT-Merge.
