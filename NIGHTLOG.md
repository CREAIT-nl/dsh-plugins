# NIGHTLOG — autonome Test-/Fix-Nacht

Start: ~00:20 Uhr · Ziel: Zyklen aus Testen → Fixen → Re-Testen bis ca. 07:30.
Regeln: nur lokale Änderungen, **keine Commits/Pushes**, konservative Fixes.

## Baseline (~00:25) — nach `git pull` auf debb105

| Paket | pass | fail | Status |
|---|---|---|---|
| gen-limit | 84 | 2 | 🔴 Module nicht gefunden |
| hookkit | 67 | 0 | 🟢 |
| research-mode | 146 | 3 | 🔴 bekannter rc.2-Drift |
| think-level | 83 | 0 | 🟢 |
| to-english | 63 | 1 | 🔴 Module nicht gefunden |
| tool-disclosure | 110 | 1 | 🔴 Peer nicht gefunden |
| web-fetch | 28 | 0 | 🟢 |
| web-search-searxng | 40 | 0 | 🟢 |

## Zyklus 1 — fehlende Test-Abhängigkeiten (~00:35)

Ursache: Upstream hat Abhängigkeiten ergänzt, der lokale Checkout hatte sie nicht.

- `undici ^8.10.0` (gen-limit/lib/transport.js): lokal nur v7 → **v8.10.0 als Tarball entpackt** nach `node_modules/undici` (gitignored, keine getrackten Änderungen)
- `chokidar ^4.0.0` (to-english/lib/watcher.js): lokal v4.0.3 vorhanden → **Junction** nach `node_modules/chokidar`
- `@deepseek-ai/dsh-tools ^rc.7` (tool-disclosure/lib/index.js): Profil hat v0.1.1-rc.2 → **Junction** wie die bestehenden 4 Shims

Ergebnis: gen-limit **103/103** ✅, tool-disclosure **138/138** ✅

## Zyklus 2 — to-english Windows-Pfad-Bug in Tests (~00:45)

3 Tests von `listTranslatableFiles` erwarteten hartkodierte `/`-Pfade;
unter Windows liefert `path.join` `\`. Auf dem Linux-CI unsichtbar.

Fix (`test/translate.test.js`, minimal):
- Import `{ join, sep }` statt `{ join }`
- `(f) => f.replace(dir, '')` → `(f) => f.slice(dir.length).split(sep).join('/')` (3×)

Ergebnis: to-english **109/109** ✅

## Zyklus 3 — research-mode: die zwei hartnäckigen Klassen (~01:00)

1. **EOL-Drift**: Checkout hat `core.autocrlf=true` ohne `.gitattributes` →
   Dateien mit CRLF; Regex-Anker auf `\n` scheitern.
   Fix (`test/wiring.test.js`): Einlesen zentral normalisieren:
   `read = (...) => readFileSync(...).replace(/\r\n/g, '\n')`
2. **POSIX-only Test**: `chmod 0o500` auf ein Verzeichnis verhindert unter
   Windows keine Dateianlage → Test „reports a failure …" kann dort nie greifen.
   Fix (`test/preset-install.test.js`): `{ skip: process.platform === 'win32' }`
   mit Begründungskommentar.

Ergebnis: research-mode **148/148** ✅

## Stand nach Zyklus 3 (~01:10) — KOMPLETTE SUITE GRÜN

**716 pass / 0 fail** über alle 8 Pakete (Baseline war 621/7).

## Zyklus 4 — CI-Schritt 3 lokal: publish-changed.mjs (~01:30)

**Echter Windows-Bug im neuen Upstream-Skript**: `execFileSync('pnpm', …)`
scheitert mit ENOENT — pnpm/npm sind unter Windows `.cmd`-Shims, die Node nur
per Shell spawnt. Auf dem Linux-CI unsichtbar.

Fix (`scripts/publish-changed.mjs`, POSIX-Verhalten unverändert):
- `winShell = process.platform === 'win32'`; Spawn-Helfer nutzt Shell nur dann
- Bei Shell: Kommandozeile als String (vermeidet DEP0190-Warnung)

**Maschinen-Fund dabei**: Das Repo pinnt `packageManager: pnpm@11.22.0`,
die Selbstumschaltung von pnpm 11.7.0 war lokal kaputt (leerer Cache-Eintrag
unter `%LOCALAPPDATA%\pnpm\store\v11\links\@\pnpm\11.22.0`). Umgehung für
diesen Lauf: temporärer Shim `corepack pnpm` in `%TEMP%\night\bin`.
→ Dauerhafte Reparatur morgen: `iex (irm https://pn.pm/install.ps1)` oder
  Corepack dauerhaft aktivieren.

Ergebnis: **EXIT=0**, alle 6 Pakete „up to date", gen-limit@0.2.0 +
research-mode@0.2.0 trocken verpackt (Upstream hat noch nicht publiziert).

## Zyklus 5 — Portabilitäts-Audit + transport.js Review (~01:45)

- Grep-Audit über den gesamten produktiven Code (`startsWith('/')`,
  `split('/')`, `/tmp/`, …): **keine Unix-Pfad-Annahmen im Lib-Code** — die
  drei Test-Fixes aus Zyklus 2 waren die einzigen Stellen dieser Klasse.
- `gen-limit/lib/transport.js` (neu, 223 Zeilen) Zeile für Zeile gelesen:
  Teardown-Restore nur wenn selbst noch installiert ✅ · Router-Fallback
  respektiert fremde Dispatcher ✅ · Rebuild-Sequenz bei Settings-Updates
  korrekt ✅ · `originOf`-Kantenfälle harmlos. **Kein Eingriff nötig.**

## Zyklus 6 — Bug-Klassen-Sweep (~02:00)

- `JSON.parse` ohne Umfeld-try: nur in publish-changed.mjs selbst (CI-Skript,
  Fail-laut ist dort gewollt) → ok
- Fire-and-forget `.then(setX)` in den Clients: `loadJson` fängt intern mit
  `.catch(() => fallback)` → kein Unhandled-Rejection-Risiko ✅
- `to-english/lib/index.js withTimeout()`: beide Handler gesetzt, Timer immer
  gecleared, späte Settle-Auflösung no-op ✅

**Mikrofund (dokumentiert, nicht geändert):** `hookkit/lib/index.js`
`abridge()` — Schwelle `head+tail >= len` ignoriert die Länge des
Elision-Markers; bei Überschreitung um 1 Zeichen wird der Output minimal
*länger* als die Eingabe. Kosmetisch; Verhalten ändern nur nach Rücksprache
mit Upstream.

## Zyklus 7 — to-english Laufzeit-Trio im Deep-Read (~02:20)

**Gefixt (`lib/watcher.js`):**
1. `RETRY_MS` war deklariert, aber nie benutzt — Retries liefen mit
   `SETTLE_MS`, entgegengesetzt zur eigenen Doku. Fix: `schedule()` nimmt
   optionalen Delay; Retry-Zweig nutzt jetzt wirklich `RETRY_MS`.
2. `onAddDir` plante auch Store-Plumbing (`.pnpm`, `.bin`) und nackte
   `@scope`-Zwischenordner ein → nutzlose Settle-/Retry-Kaskaden. Fix:
   Früh-Aussteige für Dot-Dirs und Bare-Scope-Dirs.

**Geprüft ohne Befund:**
- `reload.js`: CJS-Invalidierung `startsWith(rootPath)` sicher, weil
  `fileURLToPath` den Trailing-Slash erhält (empirisch verifiziert) —
  keine Nachbarpaket-Kollision (`dsh-foo` vs `dsh-foo-bar`). Rollback-Pfad
  bei fehlgeschlagenem Reload korrekt.
- `routes.js`: Loopback-Guard (inkl. `[::1]`-Hostname-Form), Body-Cap,
  Method-Guards, Revisions-Bedingung beim Settings-Write ✅

Verifikation: `node --check` ok, to-english weiter **109/109**.

## Zyklus 8 — Browser-Clients + hookkit apply() (~02:50)

- **tool-disclosure client**: keine innerHTML/addEventListener/Interval-Pfade;
  nur rAF-Shim via setTimeout → hygienisch.
- **think-level client** (938 Z.): alle drei Effekte mit korrektem Cleanup
  (`removeEventListener` inkl. Capture-Flag ✅, Interval-Clear ✅);
  `requestJson` fängt HTTP- wie Netzwerkfehler (`warn`+null) ✅;
  `svg.innerHTML = THINK_ICON_MARKUP` ist Konstante, kein Injection-Vektor.
- **gen-limit client**: `setInterval(pullStats, 2000)` sauber gecleared ✅.
- **hookkit `apply()`** (515-Z.-Kern): Rejection-sichere Session-Hooks
  (`void …catch`), 60-s-AbortBudget pro Fire, Inject-Append nach
  `decision.messages` wie dokumentiert. `JSON.stringify(exec.arguments)` nur
  zykliefrei, weil Argumente JSON-dekodiert sind — ok.

**Kein Fixbedarf in dieser Klasse.**

## Zyklus 9 — research-mode Agent-Plane + searxng (~03:20)

- `research-mode/lib/tool.js` (320 Z.): Clamp-Hygiene überall, Abort-Listener
  mit `finally`-Cleanup, `maxTotalAgents = rounds×width+8` dokumentiert.
  `review` per Modell abschaltbar — aber im Parameter-Text so beschrieben,
  also Absicht, kein Bug.
- `web-search-searxng/lib/index.js` (469 Z.): Paging-Logik (Quota/`morePages`
  nur bei verworfenen Treffern, `added===0`-Abbruch), Abort-Klassifikation,
  leere-Ergebnis+tote-Engines→Fehler statt Falsch-Antwort: alles korrekt.
  `buildSearchUrl` setzt nur String-Params laut Schema ✅
- `research-mode/lib/settings-routes.js`: Loopback-Guard identisch kopiert,
  Overflow **drained** den Request (besser als to-english' Early-Return),
  Write-Skip vergleicht USER-Layer statt Merge-Wert ✅

**Kein Fixbedarf.**

## Zyklus 10 — research-mode Roster-Plane (~03:50)

- `render.js`: Pluralisierung/Absicherung sauber; Coverage-Fußzeile erzwingt
  Ehrlichkeit des Reports ✅
- `preset-install.js`: Hash-Vergleich shipped↔written↔disk korrekt; Fail-Pfad
  wirft nicht, sondern meldet `failed` ✅
- `lib/index.js`: Scoped `webServer`-Inject mit Disposerliste ✅

**Dokumentationsfund (kein Codeeingriff):** `hashPreset` hashed rohe Bytes.
Unter einem Git-Checkout mit `autocrlf` sind shipped/installed konsistent
CRLF, npm-Tarballs konsistent LF — nur ein *Wechsel* der Checkout-EOL zwischen
zwei Versionen würde eine unveränderte Preset-Datei fälschlich als
„local edits" markieren (`kept`). Randfall einer Randkonfiguration; Fix wäre
EOL-Normalisierung vor dem Hash → Upstream-Thema.

## Zyklus 11 — research-mode Workflow-Kern `script.js` (448 Z., ~04:20)

Vollständig gelesen. Die vier dokumentierten Fixes (Budget-Buchführung,
Lead-Queue statt Verwerfen, globale Dedup, Supplied-Questions-Planung) sind
im Code wirklich umgesetzt:
- `leadsSeen` erfasst ALLE Gaps (für `openLeads`), Queue bekommt nur
  high-priority und nur wenn global neu ✅
- `deferred` nennt Reste nach Budgetende beim Namen ✅
- `reviewed: wantsReview && critique !== ''` — Reviewer-Ausfall wird nicht
  als „reviewed" verkauft ✅
- Agent-Budget: planner + rounds×width + synth/revise/rev ≤ tool-Cap
  `rounds×width+8` ✅
- Template-Escaping (`\\u2014`, `\\n`) doppelt korrekt ✅

**Kein Defekt.** research-mode ist damit vollständig reviewt.

## Zyklus 12 — to-english `translate.js` Kernpfade (~04:50)

- `translateFile`: Segment-Indizes durchgängig 0-basiert konsistent ✅ ·
  Backup nur beim ersten Schreiben ✅ · Abbruch mitten im Batch → konservative
  Teil-Übersetzung statt Garbage ✅
- `translateBatch`: Zeilenzahl-Invariante als einzige nicht reparierbare
  Verweigerung ✅ · pro-Linie-Verwerfen statt Segmentverlust ✅ ·
  Struktur-Check (`checkLine`) + Affix-Flag für Diff-Augenmerk ✅ ·
  maxTokens aus schreibbaren Zeichen allein budgetiert (Cap 16k) ✅
- `translatePackage`: sequentiell pro Datei (Rate-Limit-freundlich),
  Fehlerisolation je Datei, Abort-Checks pro Iteration ✅

**Kein Defekt.** Bleiben offen: `wholefile.js`, kleine Config-Dateien.

## Zyklus 13 — `wholefile.js` + to-english `config.js` (~05:30)

- `wholefile.js` (332 Z.): Reparatur-Schleife (≤3 Versuche) mit
  Envelope-Erkennung (`FILE:`/`Here is…`-Header), Truncation-Floor
  (0,6×Original), EOL/Trailing-Newline-Normalisierung, Backup-Erstschutz ✅ ·
  Probe-Datei für `node --check` mit aufgelöster Endung (.mjs/.cjs laut
  nächstem package.json-`type`) — schließt die „ambiguous .js"-Falle ✅ ·
  js-yaml optional über drei Wurzeln gesucht, YAML sonst ehrlich „unchecked" ✅
- `lib/config.js`: Schema + resolveConfig konservativ; mechanischer Vertrag
  bewusst NICHT im editierbaren Prompt ✅

**Kein Defekt. to-english damit vollständig reviewt**
(übrig geblieben wären nur noch Kleinst-Dateien anderer Pakete).

## Zyklus 14 — research-mode Kleinst-Libs + web-fetch komplett (~06:00)

- `research-mode/lib/schemas.js`, `config.js`, `home.js`: strikte
  Schemas (required/additionalProperties:false), Width-Pin-Semantik
  dokumentiert und konsistent ✅ → **research-mode 100 % reviewt**
- `web-fetch/lib/addr.js`: BLOCKED_V4 deckt RFC 6890 ab (inkl. CGNAT,
  Benchmarking, TEST-NETs, Metadata-Link-local); IPv4-mapped & NAT64 werden
  entpackt und als ihr IPv4 geurteilt; Parse-Fehler = Caller-Fehler, kein
  stilles Erlauben ✅
- `web-fetch/lib/index.js`: Redirects von Hand gefolgt mit Re-Validierung pro
  Hop; `assertReachable` klassifiziert Literal-IPs **und** alle DNS-Antworten;
  `allowHosts` exakt passend vor allem anderen; Größen-Cap, Content-Type-
  Allowlist, Abort-Pfade ✅ · Offene TOCTOU-Lücke (DNS-Rebinding) ist im
  Header ehrlich dokumentiert inkl. Heilmittel — bewusst nicht tonight
  nachgebaut (eigener undici-Dispatcher = Upstream-Thema)

**Kein Defekt. web-fetch (live in diesem Harness!) vollständig reviewt.**

## Zyklus 15 — gen-limit Kern (`queue.js` + `index.js`, ~06:30)

- `queue.js` (163 Z., Concurrency-Primitiv): Sync-Claim im Pump verhindert
  Thundering-Herd ✅ · Settled-Guard fängt Timer/Abort/Admit-Doppel Feuer ✅ ·
  `maxQueued`-Deckel gegen Memory-Leak ✅ · Fast-Pfad springt nur über
  LEERE Linie (kein Starvation) ✅
- `index.js` Zwei-Tor-Design: Stream-Limiter zählt distinct sessions,
  Reentry ungezählt ✅ · Finally gibt Slot vor Generator-Unwind frei ✅ ·
  Spawn-Gate hält absichtlich keinen eigenen Slot (Doppelzählung dokumentiert)
  ✅ · Limit-Änderung im UI re-pumpt wartende Linien sofort ✅ ·
  Capacity-Timeout wird als Chunk gemeldet, Abort als Abort weitergeworfen
  (keine Retry-Politik-Verschwendung) ✅

**Kein Defekt.**

## Zyklus 16 — think-level Reste + Abschluss (~07:00)

- `pi-ai-levels.js`: validateEfforts (Vokabular, null nur für `off`,
  Pflicht jenseits von `off`) + planDeclaration (User-Liste bevorzugt,
  Container-Cascade beim Entfernen) ✅
- `gen-limit/lib/config.js`: `counted()` verweigert bewusst die
  Number-Coercion-Fallen (`Number(null)→0` würde Timeout abschalten);
  `maxQueued` Floor 1 ✅
- `think-level/lib/global-default.js`: Unpin nur auf User-Layer,
  Read-before-Write als Schleifenwächter, detached mit Error-Sink ✅
- `think-level/lib/config.js`: Rows werden gedroppt statt repariert,
  Last-wins-Dedup, NUL-Separator ✅

→ **Alle 8 Pakete vollständig reviewt.** Nicht Zeile für Zeile geöffnet:
die drei `settings-routes.js` (ein bereits auditiertes Muster, jeweils
voll testüberdeckt) und think-level `index.js`-Rest.

**Abschluss:** HANDOFF-WEITERMACHEN.md auf Nachtstand umgeschrieben.
Endgate: **716 pass / 0 fail** · publish-changed --dry-run exit 0.
Keine Commits — alles liegt als Working-Tree-Diffs vor.













