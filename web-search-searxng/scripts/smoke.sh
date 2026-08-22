#!/usr/bin/env bash
# Smoke-test the SearXNG search provider against the installed dsh.
# Fails loudly if a dsh update broke the wiring or the capability seam.
set -uo pipefail

PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE"
fail=0
check() { if [ "$1" -eq 0 ]; then echo "  ok   $2"; else echo "  FAIL $2"; fail=1; fi; }

echo "dsh: $(command -v dsh || echo '<not on PATH>')  $(dsh --version 2>/dev/null || echo '?')"
command -v dsh >/dev/null; check $? "dsh on PATH"

# The plugin is inert unless all three patch rows survive composition.
config=$(dsh --profile "$PROFILE" --dump-config 2>/dev/null)
check $? "profile '$PROFILE' composes"
grep -q "searchProvider: searxng" <<<"$config"; check $? "web.searchProvider = searxng"
grep -q "@creait/dsh-web-search-searxng" <<<"$config"; check $? "searxng provider row present"
grep -qA2 "id: web-search-deepseek" <<<"$config" && grep -q "disabled: true" <<<"$config"
check $? "stock deepseek provider disabled"

# Two hops, and they fail independently. The profile's node_modules link resolves
# the plugin; the plugin's own bare imports then resolve by parent-walk from its
# REALPATH, which only reaches $DSH_HOME/profiles/node_modules while the plugin
# lives under profiles/. Move the real directory elsewhere and this hop breaks
# while the first still passes.
node -e '
const { createRequire } = require("module");
const { realpathSync } = require("fs");
const entry = createRequire(process.argv[1] + "/package.json").resolve("@creait/dsh-web-search-searxng");
const inner = createRequire(realpathSync(entry));
for (const m of ["@deepseek-ai/dsh-web","@deepseek-ai/cordis","@deepseek-ai/schemastery"]) inner.resolve(m);
' "$PROFILE_DIR" 2>/dev/null; check $? "plugin resolves, and its peers resolve from its realpath"

# End-to-end: the real provider class against the real SearXNG instance.
( cd "$PROFILE_DIR" && node --input-type=module -e '
const { SearxngSearchProvider } = await import("@creait/dsh-web-search-searxng");
const base = process.env.SEARXNG_URL ?? "http://localhost:8080";
const p = new SearxngSearchProvider(() => ({ baseURL: base, maxResults: 3, categories: "", language: "", userAgent: "dsh-smoke" }));
if (!p.available()) { console.error("provider reports unavailable"); process.exit(1); }
const r = await p.search({ query: "deepseek harness", maxResults: 3 });
if (!Array.isArray(r.sources) || r.sources.length === 0) { console.error("no sources returned"); process.exit(1); }
if (typeof r.sources[0].url !== "string") { console.error("result shape changed"); process.exit(1); }
' ) 2>/dev/null; check $? "live search returns sources"

if [ "$fail" -ne 0 ]; then echo; echo "SMOKE FAILED"; exit 1; fi
echo; echo "SMOKE OK"
