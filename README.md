# dsh-plugins

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai). One repo, five
packages, published independently under `@creait`. They came out of running dsh
against self-hosted models, and each closes a gap the harness leaves open.

| Package | What it does | Why |
|---|---|---|
| **[hookkit](./hookkit)**<br>`@creait/dsh-hookkit` | Config-driven lifecycle hooks, **including context injection**. Declare `event → handler → outcome` in YAML. | dsh has the seams (`agent/pre-step`, `tools/pre-execute`, …) but reaching them means writing a plugin. This turns them into config. |
| **[gen-limit](./gen-limit)**<br>`@creait/dsh-gen-limit` | Per provider/model concurrency cap, enforced at subagent spawn and at the stream, with a settings card. | One self-hosted GPU has a real ceiling; a fan-out of subagents will find it. Denying the spawn beats letting the child die opaquely. |
| **[web-search-searxng](./web-search-searxng)**<br>`@creait/dsh-web-search-searxng` | Points `web_search` at a self-hosted SearXNG instance instead of the native route. | Search without handing every query to a third party. |
| **[web-fetch](./web-fetch)**<br>`@creait/dsh-web-fetch` | A guarded local fetch provider behind `ctx.web`, with SSRF blocking on the resolved address. | dsh implements `web_fetch` in full but ships no provider, so the tool is present and every call fails. |
| **[research-mode](./research-mode)**<br>`@creait/dsh-research-mode` | Deep research as an agent **mode**: a fixed, reviewed loop that plans, researches in adaptive parallel rounds, synthesises and reviews. | A loop the model rewrites per call re-earns the same mistakes per call. Shipping it as a preset also keeps it out of every session that is not research. |

hookkit is the general-purpose one: a small engine that ships **no hooks of its
own** — 13 lifecycle events × 3 handler kinds (in-process tool, shell, HTTP) ×
3 outcomes (inject context, deny the call, fire-and-forget). It is what makes
something like memory recall a config change rather than a plugin. The rest are
single-purpose. web-search-searxng and web-fetch are both providers for the same
`ctx.web` seam and compose: together they give an agent search and page reading
without a third-party round trip. research-mode wants web-fetch mounted —
without it, its researchers are capped at search snippets.

## Install

Each package installs on its own — you do not need the others:

```sh
dsh plugin --profile web add @creait/dsh-hookkit
```

## Develop

The packages resolve their dsh peer dependencies from the harness you have
installed, not from the registry, so you are always building against the
version you actually run:

```sh
DSH="$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai"
mkdir -p node_modules/@deepseek-ai
for p in cordis dsh-llm dsh-settings dsh-web schemastery; do
  ln -sfn "$DSH/$p" "node_modules/@deepseek-ai/$p"
done
```

Then:

```sh
pnpm test        # 194 tests across the five packages
```

Do not run `pnpm install` at the root — it would replace those symlinks with
published copies that may not match your harness.

To run a checkout against a live harness, link the package directory into a
profile:

```jsonc
// ~/.dsh/profiles/web/package.json
"dependencies": {
  "@creait/dsh-hookkit": "link:/path/to/dsh-plugins/hookkit"
}
```

then `pnpm install` in the profile and restart `dsh web`. The boot manifest is
built at startup, so adding a plugin needs the restart — editing a linked one
does not.

## Release

Versions are independent; publish only what changed:

```sh
cd hookkit && npm publish --access public
```

`pnpm publish-all` does every package that has a new version. Scoped packages
default to restricted, so `--access public` matters on a package's first
publish.

## Caveat

All five bind to pre-1.0 internal dsh seams with no compatibility guarantee.
`peerDependencies` pins the versions each was built against; a harness upgrade
can move them. Each README has a "What breaks this" section.

## License

MIT.

`research-mode`'s loop design is ported from
[`dsh-deep-research`](https://github.com/omdsh-dev/dsh-deep-research)
(MIT, Copyright (c) 2026 dsh2026); see `research-mode/LICENSE` for the
acknowledgement. Everything else here is original.
