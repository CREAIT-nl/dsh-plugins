# @creait/dsh-web-search-searxng

SearXNG-backed search provider for the DeepSeek Harness `ctx.web` capability
seam. It replaces the stock DeepSeek search route, so the model-facing
`web_search` tool queries a self-hosted SearXNG instance instead.

## Install

```sh
dsh plugin --profile web add @creait/dsh-web-search-searxng
```

That mounts the provider — and mounting it changes nothing yet. `baseURL` has
no default, so an unconfigured row reports itself unavailable and `ctx.web` goes
on selecting the shipped DeepSeek provider exactly as it did before. Two keys
switch the search over, in your profile patch —
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`, where `$DSH_HOME` defaults to
`~/.dsh`:

```yaml
- id: web
  config:
    searchProvider: searxng

- id: web-search-searxng
  config:
    baseURL: http://localhost:8080   # your SearXNG instance
    maxResults: 10
    engines: bing,google,wikipedia
```

Both are required, and they fail differently. Without `baseURL` the provider
stays unavailable, so naming it costs you every search with
`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`. Without `searchProvider` two usable
providers are registered and nothing chose between them, which is
`WEB_PROVIDER_AMBIGUOUS`.

Disabling the shipped provider is a separate decision: naming one in
`searchProvider` is what resolves the ambiguity, so `web-search-deepseek` can
stay mounted as a fallback you can switch back to by editing one line.

```yaml
- id: web-search-deepseek
  disabled: true
```

If you installed this before it shipped a bundle patch, your profile patch
inserts the row by hand. Drop that `- insert:` block and keep the
`- id: web-search-searxng` config override above: `insert` appends
unconditionally, and a second row would register the same provider id twice,
which `ctx.web` rejects with `WEB_DUPLICATE_PROVIDER`.

### How the peers resolve

The plugin imports `@deepseek-ai/dsh-web`, `@deepseek-ai/cordis` and
`@deepseek-ai/schemastery` as bare specifiers, and nothing installs them beside
it. They resolve by Node's parent-directory walk from the package's **realpath**
into `$DSH_HOME/profiles/node_modules` — the flat closure dsh maintains (one
symlink per package in the installation's dependency graph, re-pointed on every
boot by `healProfilesModuleFallback`).

Node resolves a symlinked package from its real location, not from the link, so
that walk starts wherever the package really lives. Installing from the registry
puts it under the profile and the walk lands where it should. Running a checkout
instead — a `link:` into a working tree outside `$DSH_HOME` — means the walk
starts in that tree, so the tree needs the peers reachable from it; the repo root
README has the symlink shim that arranges exactly that.

Installing the peers locally instead is not a fix: a second copy of
`@deepseek-ai/dsh-web` means a second `WebError` class and a second `ctx.web`
service identity. That is what `peerDependencies` is preventing.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `baseURL` | none | SearXNG instance, trailing slashes stripped. Empty means unavailable: the row mounts, the seam ignores it |
| `maxResults` | `10` | Sources returned; reached by paging, see below |
| `maxPages` | `3` | Ceiling on result pages fetched for one search |
| `engines` | `''` | Comma-separated engine pin, e.g. `bing,google` |
| `timeRange` | `''` | `day` \| `week` \| `month` \| `year` — freshness window |
| `categories` | `''` | e.g. `news`, `science` |
| `language` | `''` | e.g. `en` |
| `userAgent` | `deepseek-harness/0.0.1 (searxng search)` | Sent on every request |

### `maxResults` costs round-trips

SearXNG has **no result-count parameter**. It accepts `count` and silently
ignores it — a request for three results still returns ten. The only lever is
`pageno`, so `maxResults` above one page's worth is reached by paging, bounded
by `maxPages`. A page that contributes nothing new ends the loop rather than
paging into repeats, and the common case (`maxResults` ≤ one page) costs exactly
one request.

### `timeRange` needs an engine that implements it

A general-web engine that does not support time filtering returns **nothing**
for a filtered query rather than ignoring the filter — and does not report
itself unresponsive. bing gives ten results for `nvidia gpu` and zero for the
same query with `time_range=week`. Freshness works in the `news` category, whose
engines implement it and populate `publishedDate`:

```yaml
config:
  categories: news
  timeRange: week
```

When a windowed search comes back empty the provider says so in `content`,
rather than letting a filter artefact read as an empty web.

## When a search returns nothing

A public-engine SearXNG instance degrades quietly. Engines get CAPTCHA'd,
rate-limited and suspended individually, and SearXNG answers with an empty
`results` array plus an `unresponsive_engines` list that the seam has nowhere to
put. The search tool renders that as `No results found.` — which the model reads
as *the web holds nothing*, and it is nothing of the kind.

On 2026-08-23 every engine in one instance's enabled general category was down
at once (duckduckgo and startpage on CAPTCHA, brave suspended for too many
requests, google returning nothing while not even reporting itself
unresponsive). Every general web search on it returned zero results, silently.

So this provider distinguishes the two:

- **No results, no failed engines** → an empty result. A genuine no-hit.
- **No results, some failed engines** → `WEB_PROVIDER_ERROR` naming them. The
  provider cannot tell an empty web from a broken search, and says so rather
  than letting the model conclude the stronger thing.
- **Some results, some failed engines** → the results, led by a
  degraded-coverage warning naming the failed engines.

`engines` is the lever: pin the ones your instance can actually reach, and add
others back as they recover.

## The `content` block

`WebSearchResult.content` is rendered by the web tool **above** the source list,
which makes it the only channel a provider has for saying something about the
search rather than about one result. Every line is conditional, because it is
paid for on every call:

- an answer SearXNG resolved outright, when there is one;
- the degraded-coverage warning above;
- the escalation to `web_fetch` — snippets are index summaries, and a question
  about live state (a price, availability, a count, a status) cannot be answered
  from them. `web_search`'s own guidance says this only when `web_fetch` is
  mounted in the *same* composition, which is false on the web surface, where
  the search tool is per-preset and the fetch half is host-plane;
- spelling corrections and query suggestions, only when nothing was found.

## Verify

`scripts/smoke.sh` in the repo checkout (it is not in the published tarball)
drives the real provider class against a real instance and checks that all three
patch rows survived composition:

```sh
DSH_PROFILE=web SEARXNG_URL=http://localhost:8080 ./scripts/smoke.sh
```

## What breaks this

The seam this binds to (`ctx.web.registerSearchProvider`, `WebError` with
`WEB_PROVIDER_ERROR` / `WEB_ABORTED`, `search() -> { content?, sources, truncated }`) is a
pre-1.0 internal API with no compatibility guarantee. `peerDependencies` pins
`@deepseek-ai/dsh-web` to `^0.1.0-rc.7`, but the profile sets
`autoInstallPeers: false`, so a mismatch is a pnpm *warning*, not a guard — at
runtime the plugin resolves whatever `$DSH_HOME/profiles/node_modules` points at
and loads against it. Treat that warning as the canary and run the smoke test
after every dsh update.

Note that `dsh`'s own dependencies float on `^0.1.0-rc.N` ranges, so a fresh
`npm i -g @deepseek-ai/dsh` can pull newer internals than the CLI's own version
suggests. Verified working against dsh CLI 0.1.0-rc.7 with rc.8 internals.
