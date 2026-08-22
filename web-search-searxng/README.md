# @creait/dsh-web-search-searxng

SearXNG-backed search provider for the DeepSeek Harness `ctx.web` capability
seam. It replaces the stock DeepSeek search route, so the model-facing
`web_search` tool queries a self-hosted SearXNG instance instead.

Not published to npm — installed into a profile as a local `link:`.

## Where this directory has to live

The real directory must stay under `$DSH_HOME/profiles/`. `~/Work/dsh-web-search-searxng`
is a convenience symlink to it, not the source of truth.

The plugin imports `@deepseek-ai/dsh-web`, `@deepseek-ai/cordis` and
`@deepseek-ai/schemastery` as bare specifiers. Nothing installs those here — they
resolve by Node's parent-directory walk from this directory's **realpath** into
`$DSH_HOME/profiles/node_modules`, the flat closure dsh maintains (one symlink per
package in the installation's dependency graph, re-pointed on every boot by
`healProfilesModuleFallback`). Node resolves symlinked packages from their real
location, so moving this directory out of `profiles/` breaks every import even
though the profile's own link still looks correct.

It sits one level down in `.plugins/` rather than directly in `profiles/` because
dsh reads any directory directly under `profiles/` as a profile name — a stray
`dsh plugin --profile web-search-searxng ...` would have run `initProfile` over it.

Installing the peers locally instead is not a fix: a second copy of
`@deepseek-ai/dsh-web` means a second `WebError` class and a second `ctx.web`
service identity. That is what `peerDependencies` is preventing.

## Install

```sh
dsh plugin --profile web add link:$HOME/.dsh/profiles/.plugins/web-search-searxng
```

That records the dependency and symlinks it into the profile. It does **not**
activate the provider: this package declares no `dsh.bundle`, so it never joins
the profile's layer stack. Activation lives in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: web
  config:
    searchProvider: searxng

- id: web-search-deepseek
  disabled: true

- insert:
    - id: web-search-searxng
      name: '@creait/dsh-web-search-searxng'
      config:
        baseURL: http://localhost:8080   # your SearXNG instance
        maxResults: 10
```

All three rows are required — drop any one and the provider goes inert or
`ctx.web` ends up with two usable providers and throws `WEB_PROVIDER_AMBIGUOUS`.

## Verify

```sh
./scripts/smoke.sh
```

## What breaks this

The seam this binds to (`ctx.web.registerSearchProvider`, `WebError` with
`WEB_PROVIDER_ERROR` / `WEB_ABORTED`, `search() -> { sources, truncated }`) is a
pre-1.0 internal API with no compatibility guarantee. `peerDependencies` pins
`@deepseek-ai/dsh-web` to `^0.1.0-rc.7`, but the profile sets
`autoInstallPeers: false`, so a mismatch is a pnpm *warning*, not a guard — at
runtime the plugin resolves whatever `$DSH_HOME/profiles/node_modules` points at
and loads against it. Treat that warning as the canary and run the smoke test
after every dsh update.

Note that `dsh`'s own dependencies float on `^0.1.0-rc.N` ranges, so a fresh
`npm i -g @deepseek-ai/dsh` can pull newer internals than the CLI's own version
suggests. Verified working against dsh CLI 0.1.0-rc.7 with rc.8 internals.
