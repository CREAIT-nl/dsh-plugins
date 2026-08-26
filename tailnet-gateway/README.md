# @creait/dsh-tailnet-gateway

Reach a loopback-bound DeepSeek Harness from your own Tailscale devices — with
Settings, Models and Plugins actually working — gated on Tailscale identity and,
optionally, on which specific machine is asking.

## The problem

Point a browser on your tailnet at a dsh instance bound to `0.0.0.0` and you get
an app that is two-thirds working. Chat is fine. Settings says settings are
unavailable in this browser, Models will not load, Plugins → Plugin
configuration is empty, and the agent-preset picker is greyed out.

That is not a bug to route around. `@deepseek-ai/dsh-client-connection` puts a
deliberate fence in front of a set of privileged RPC methods —
`settings.describe/update/replace/mutate`, `credentials.describe/set/unset`,
`agentPreset.*`, `host.pickDirectory`, `host.openPath`, `llm.discoverModels` —
and lets them through only from loopback. It is defending against DNS rebinding
and cross-site calls, and it means it: the privileged branch re-runs the trust
check with an **empty** trusted-host list, so `--trusted-host` cannot open it.
Anything else gets `403 forbidden`.

The client half compounds it. It decides `isLoopback` from
`window.location.hostname` alone, so over a tailnet URL the settings pages build
a throwaway in-memory store and never send the RPC at all — which is why the
symptom reads as a broken page rather than a permission error.

So binding to `0.0.0.0` buys a half-working app *and* exposes dsh to the whole
LAN. Neither half of that trade is good.

## The shape of the fix

dsh stays on `127.0.0.1` and is never directly reachable. This plugin listens on
a second loopback port; `tailscale serve` publishes **that** port to the tailnet
over TLS. Every request arriving there has already been through `tailscaled`,
which terminates the TLS, stamps `Tailscale-User-Login` and `X-Forwarded-For`,
and **overwrites whatever the client sent** — which is what makes the identity
unforgeable. Requests that pass the gate are forwarded to dsh as what they
genuinely are: a loopback call from the same machine. Requests that fail are
refused with 403 and never touch dsh at all.

```
tailnet device ──TLS──▶ tailscale serve ──▶ gateway :7242 ──▶ dsh :7241
                        (stamps identity)   (gate + rewrite)   (127.0.0.1)
```

## Two gates

**Login.** The Tailscale account behind the request must be allowed. An empty
allowlist means *the account that owns this node*, so a single-user tailnet
needs no configuration to be correct. This gate alone already excludes tagged
servers — a machine joined with an auth key has no human owner and its login
reads as `tagged-devices`.

**Device.** The specific machine must be on the allowlist, matched by its short
tailnet name (`laptop`, not an IP, which moves). Off by default, because an
empty allowlist with the gate on locks out the device that would turn it on. Fill
the list first, then switch it on. This is what makes "my phone and my laptop,
never that VPS" expressible even when the VPS is signed in as you.

Both gates fail closed on a missing fact: no identity header means no admission,
and an unresolvable peer means no admission while the device gate is on — a
request that did not come through `tailscale serve` therefore fails both. If
`tailscale status` cannot be read at all, the last known peer table is kept
rather than an empty one, because a tailscaled restart must not silently suspend
the allowlist.

## Settings → Tailnet Access

A top-level settings page: gateway on/off with its live listening address and
the `tailscale serve` line to publish it, the login gate and its allowlist, the
device gate and every peer on your tailnet with a one-click Allowed/Blocked
control, and the loopback override below.

The config route refuses a write that would lock **you** out — turning the
device gate on without ticking your own laptop is answered with an error rather
than an unreachable machine, and the only way back from that would be a shell on
the box.

## The loopback override

`trustGatewayClients` (on by default) is what fixes the client half. The client
cannot be told the truth at runtime: `dsh-client-ui-settings` reads
`connection.isLoopback` inside its own `apply()`, and the connection plugin
computes it inside `apply()` too, so a third plugin mutating the service
afterwards would be racing a value that has already been read. The honest place
to state it is the served bundle, so the gateway substitutes that one line as it
proxies `/plugins/@deepseek-ai/dsh-client-connection/client.js`.

It is a single literal substitution, not a parse, on a file dsh serves
uncompressed. If a dsh upgrade changes the line the substitution simply does not
match: the app keeps working, the settings pages fall back to their stub store,
and the log says so once.

Turning this off leaves the gateway doing its access half and gives the settings
pages back their remote behaviour — which is to say, back to not working.

## Why it must stay on loopback

The gateway's whole job is to convert an authenticated tailnet request into a
loopback one, so it holds loopback trust. Bound to a public interface it would
hand that trust to anyone who asks, because a direct caller can set both headers
itself. `resolveConfig` clamps the bind address to `127.0.0.1`/`::1` and
`startGateway` refuses to listen anywhere else.

## Install

```bash
dsh plugin --profile web add @creait/dsh-tailnet-gateway
```

Restart `dsh web` afterwards: the boot manifest is built at startup.

Then bind dsh itself to loopback — it must not be reachable on the tailnet
directly, or the gate is just a second door into an already-open room — and
publish the gateway:

```bash
tailscale serve --bg <gateway port>
```

Settings → Tailnet Access shows that command with the port it actually bound.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Run the listener at all. |
| `host` | `127.0.0.1` | Bind address; loopback only, enforced. |
| `port` | `7242` | The port `tailscale serve` publishes. |
| `requireLogin` | `true` | Demand a Tailscale identity on every request. |
| `allowedLogins` | `[]` | Empty means the login that owns this node. |
| `deviceAllowlist` | `false` | Also gate on which machine is asking. |
| `allowedDevices` | `[]` | Short tailnet names, e.g. `laptop`. |
| `trustGatewayClients` | `true` | Tell the served client this hop is loopback. |
| `statusTtlMs` | `30000` | How long one `tailscale status` read is reused. |

## Tests

```sh
node --test test/*.test.js
```

`gate.test.js` pins the admission table and the header rewriting; `proxy.test.js`
drives a real gateway over real sockets against a stand-in dsh, and checks the
things only a running server shows — that a refused request never reaches the
upstream at all, that the bundle is rewritten in flight, and that an upgrade is
tunnelled rather than answered.

## What breaks this

The loopback override is a text substitution against a build artifact. The
client bundle is minified but not mangled beyond recognition, and the marker it
looks for is the compiled form of one property initialiser in
`dsh-client-connection`. A harness upgrade that renames the helper, reorders the
object, or changes how the hostname is read moves that marker; the rewrite then
matches nothing. It fails open in the safe direction — the bundle is passed
through byte-for-byte, the access half keeps working, and the settings pages go
back to being read-only over the tailnet — and it says so once in the log rather
than silently. If that happens, either update the marker or turn
`trustGatewayClients` off until you do.

Both gates rest on `tailscale serve` stamping `Tailscale-User-Login` and
`X-Forwarded-For` and, crucially, on it *overwriting* whatever the client sent.
That is what makes the headers evidence rather than a claim. Anything else in
front of the gateway — a reverse proxy, a port-forward, a second hop — removes
that guarantee, which is why the bind address is clamped rather than
configurable. A gateway reachable from anywhere but loopback is a gateway that
hands loopback trust to whoever asks for it.

Identity is resolved by shelling out to `tailscale status --json` and reading
`Self`, `Peer` and `User`. Those field names are stable across the versions this
was built against but are not a documented API. A read that fails keeps the last
good table rather than falling back to an empty one, so a transient tailscaled
restart refuses nothing; a permanently broken read means the device gate refuses
everything, which is the direction you want to fail in.

`settings.section` is a pre-1.0 slot and the config routes live on the plugin's
own paths rather than the settings RPC, because that RPC is behind the same
browser-trust fence this plugin exists to cross. `peerDependencies` pins the
versions this was built against; a harness upgrade can move them.

## License

MIT
