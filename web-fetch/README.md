# @creait/dsh-web-fetch

The backend DeepSeek Harness's `web_fetch` tool is missing.

## Why this exists

`@deepseek-ai/dsh-tool-web` already implements the entire model-facing `web_fetch`
tool: argument schema, validation, timeout budget, HTML→markdown rendering,
output cap with a truncation footer, and the fetch card the web UI draws. What
dsh does not ship is a *provider* for the fetch half of the `ctx.web` seam, so
`dsh-base` mounts the tool with `fetch: false` and the capability is inert.

The bundle says why:

> Fetch stays disabled and no fetch provider is mounted: that provider defers
> SSRF protection and the model would choose the request target.

That is a statement about ownership, not a verdict that fetching is unsafe. The
provider is where the guards belong, and dsh's own error taxonomy names the set
it expects one to carry — *"invalid or blocked URLs, redirects, size and timeout
limits, and unsupported content types."* This package is that provider.

## Install

```bash
dsh plugin --profile web add @creait/dsh-web-fetch
```

Then point the seam at it and turn the tool on, in your profile patch:

```yaml
- id: web
  config:
    fetchProvider: local

- id: tool-web
  config:
    fetch: true

- insert:
    - id: web-fetch
      name: '@creait/dsh-web-fetch'
```

Restart `dsh` — the boot manifest is assembled at startup.

## Guards

| Guard | Behaviour |
| --- | --- |
| Scheme | `http:` and `https:` only |
| Credentials | URLs carrying `user:pass@` are refused outright |
| Address | Every resolved address is checked against loopback, RFC 1918, CGNAT, link-local (incl. `169.254.169.254`), multicast, reserved and IPv6 ULA/link-local ranges |
| IPv4-in-IPv6 | `::ffff:` and `64:ff9b::` addresses are unwrapped and judged as the IPv4 they carry |
| Multi-homed names | A hostname resolving to *any* blocked address is refused — which address `fetch` would pick is not ours to decide |
| Redirects | Followed by hand, capped at `maxRedirects`, and **every hop is re-resolved and re-checked** |
| Size | Body is streamed and cut at `maxBytes`; the result reports `truncated` |
| Content type | HTML and text-ish types only; anything else is an error rather than mojibake |
| Cancellation | The seam's `AbortSignal` is honoured before and during the request |

A non-2xx response is a **result**, not an error — the status code is part of
the resource's state, and the seam's contract says so.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `maxBytes` | `5242880` | Ceiling on the buffered body |
| `maxRedirects` | `5` | Hops followed before refusing |
| `allowHosts` | `[]` | Exact hostnames allowed to resolve into blocked ranges |
| `blockHosts` | `[]` | Exact hostnames always refused |
| `userAgent` | `deepseek-harness/0.0.1 (web fetch)` | Sent on every request |

`allowHosts` is the deliberate escape hatch for reaching something on your own
network — a LAN wiki, an internal dashboard:

```yaml
- id: web-fetch
  config:
    allowHosts: ['dgx1', 'wiki.lan']
```

## Known limitation: DNS rebinding

The window between resolving a hostname and the connection being made is not
closed. A name whose DNS flips to a private address inside that window would be
*checked* as public and *connected* as private, because global `fetch`
re-resolves on its own and offers no pinned-address dispatcher.

Closing it needs a custom undici dispatcher whose `connect` re-validates the
resolved peer, which is a real dependency this package does not currently take.
On a trusted workstation network the residual risk is small — but it is not
zero, and `allowHosts`/`blockHosts` are the levers if your threat model needs
them tighter.

## Tests

```bash
node --test test/*.test.js
```

Covers the address classifier range by range (including the IPv4-in-IPv6 unwrap
paths, where a subtle parser bug would have let `64:ff9b::169.254.169.254`
through) and drives the provider against a stubbed `fetch` for redirect
re-validation, hop caps, allow/block lists, content-type handling and
cancellation.

## Licence

MIT
