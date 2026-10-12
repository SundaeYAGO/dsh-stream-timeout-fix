# dsh-stream-timeout-fix

**English** · [简体中文](https://github.com/SundaeYAGO/dsh-stream-timeout-fix/blob/main/README.zh-CN.md)

[![CI](https://github.com/SundaeYAGO/dsh-stream-timeout-fix/actions/workflows/ci.yml/badge.svg)](https://github.com/SundaeYAGO/dsh-stream-timeout-fix/actions/workflows/ci.yml)

A tiny **DeepSeek Harness (DSH)** host plugin that stops Node's built-in `fetch`
from killing long, silently-stalled LLM streams — the ones that die with

```
TypeError: terminated        (cause: BodyTimeoutError, UND_ERR_BODY_TIMEOUT)
```

after roughly 304–305 seconds of mid-stream silence, and get reported as a
`TRANSPORT` failure even though the provider never hung up.

> **Who this is for.** Third-party / self-hosted OpenAI-compatible endpoints whose
> responses can take a long time and occasionally stall mid-stream: university or
> company private deployments, LiteLLM-style gateways, self-hosted vLLM, and the
> like. Against a well-behaved large cloud API you probably do not need it.
>
> **Maintenance.** Written by the author for personal use, and published in case it
> helps someone else. It may not be actively maintained, issues and PRs may go
> unanswered, and there is no support commitment. The plugin is ~120 lines — read it
> before you install it. See **Validation status** below for what has (and has not)
> actually been observed.

---

## The symptom

With a streaming LLM endpoint, some requests fail like this:

* the SSE response is **already established and content has started flowing**
  (reasoning tokens, partial answers, tool-call deltas), then
* **nothing arrives for minutes** while the upstream keeps generating, and then
* the request dies locally after ~304–305 s of silence with
  `TypeError: terminated`, classified as a transport/network error.

The provider's own logs show the opposite of a provider-side failure: it records a
**client disconnect** (LiteLLM / nginx log `499`) and the upstream **still finishes
generating and still bills the tokens** — you pay for output you never received.

## The root cause

Node's built-in `fetch` runs on [undici](https://github.com/nodejs/undici), which
ships two client-side clocks that are invisible until they fire:

| Clock | Default | Applies to | Error when it fires |
|---|---|---|---|
| `headersTimeout` | `300_000 ms` | waiting for the first response byte | `TypeError: fetch failed`, cause `HeadersTimeoutError` (`UND_ERR_HEADERS_TIMEOUT`) |
| `bodyTimeout` | `300_000 ms` | idle gap **between body bytes** (re-armed by every received byte) | `TypeError: terminated`, cause `BodyTimeoutError` (`UND_ERR_BODY_TIMEOUT`) |

Because `bodyTimeout` is re-armed per byte, ordinary slow-but-flowing streams are
never affected (streams running 20+ minutes are fine). It only bites when the
**gap** exceeds 300 s — exactly what a stalled upstream produces.

Two things make this hard to attribute correctly:

1. `bodyTimeout` reports itself as **`terminated`**, i.e. literally "the other side
   disconnected". Nothing points at the client's own clock.
2. DSH's failure classifier matches `/terminated/` and maps it to `TRANSPORT`
   (see `dsh-llm-pi-ai`), which reads as a network/provider problem.

So the observable facts (client disconnect in the provider log, `499`, successful
upstream generation, a `TRANSPORT` error on our side) all look like "the platform
drops idle connections at ~300 s" — while the actual killer is our own default.

## What this plugin does

DSH's LLM path never passes a custom `fetch`
(`dsh-llm-pi-ai` → `pi-ai` → OpenAI SDK v6 → `globalThis.fetch` → **global undici
dispatcher**), so one process-wide swap covers every provider at once:

```js
setGlobalDispatcher(new Agent({ bodyTimeout: 1_800_000, headersTimeout: 600_000 }))
```

* `bodyTimeout = 30 min`, `headersTimeout = 10 min` by default — finite on purpose,
  so a genuinely dead peer is still reclaimed.
* Stream-level watchdogs (e.g. pi-ai's `streamIdleTimeoutMs`) and provider retry
  policies remain the real guards; this plugin only removes the *disagreement*
  between two idle clocks.
* Cross-version injection is fine: the global dispatcher lives in a process-wide
  `Symbol.for('undici.globalDispatcher.1')` slot, so an `Agent` created by undici
  8.x is honored by Node's built-in `fetch` (undici 7.x).

## Validation status (read before trusting it)

This plugin was written *after* diagnosing the failure, and it is proven by controlled
local reproduction plus its own test suite — **not** by a real-world stall:

* **Reproduced locally.** A stream that goes silent mid-body is killed by undici's
  default clock at last-byte + ~304 s with `TypeError: terminated`
  (`UND_ERR_BODY_TIMEOUT`); with this plugin's agent the same silence completes
  (`npm test`, `scripts/reproduce-300s.mjs`).
* **Fingerprint match.** Every production failure this was written for showed a
  silence gap of 304.6–305.4 s, `message: "terminated"`, always after content had
  started flowing, never in the headers phase.
* **Not yet observed end-to-end.** Since installation, no real 300+ s stall has
  occurred, so "a genuinely stalled request now survives and completes" is still an
  inference rather than a witnessed event. The first real stall after installing is
  the actual acceptance test.

If a request still dies during a long silence, compare the gap length: **304–305 s**
points at an undici default clock somewhere in the stack, while anything clearly
different points at a server/gateway idle limit — which this plugin does not address.

## Install

**Requires Node ≥ 22.19** — that is the `undici` dependency's engine requirement
(`engines.node >= 22.19.0`). Any DSH build able to mount this plugin already bundles
undici 8.x itself, so this matches the real deployment range; on Node 20 the import
fails instead of silently misbehaving.

With the DSH CLI (the bundle patch mounts the plugin row automatically — no manual
profile patch edit):

```bash
dsh plugin --profile <profile-name> add dsh-stream-timeout-fix
```

Manually, in the profile directory (`~/.dsh/profiles/<profile>`):

1. add the dependency: `"dsh-stream-timeout-fix": "^1.0.0"` (then install), and
2. append `"dsh-stream-timeout-fix"` to `dsh.profile.bundles` in `package.json`.

Then restart DSH (or check your version's live-apply behaviour — this plugin also
hot-mounts on profiles that support live bundle application).

## Verify

* The loader lists the entry as enabled/active (`include:stream-timeout-fix`).
* The host log contains one activation line:
  `[stream-timeout-fix] global dispatcher replaced: bodyTimeout=1800000ms, headersTimeout=600000ms ...`
* Runtime marker: `globalThis.__streamTimeoutFix` holds the installed `Agent`,
  the effective timeouts, and the runtime versions.
* The real proof is passive: the next 300+ s stall your provider has will no longer
  kill the request. If a request *does* still die during a long silence, check the
  gap length — anything clearly different from 304–305 s points at a genuine
  server/gateway idle limit rather than this client clock.

## Configuration

| Setting | Default | Where |
|---|---|---|
| `bodyTimeoutMs` | `1800000` | patch row `config`, or env `DSH_STREAM_TIMEOUT_BODY_MS` |
| `headersTimeoutMs` | `600000` | patch row `config`, or env `DSH_STREAM_TIMEOUT_HEADERS_MS` |

Set either to `0` to disable that clock entirely (not recommended globally — you
lose the last-resort reclamation of dead sockets).

## What this plugin does not do

* **No retries.** It ships no retry policy and never re-sends a request. Retrying is
  the job of DSH's own retry plugin (`@deepseek-ai/dsh-llm-retry`), configured per
  provider in your profile patch — see the pairing section below if you want both.
* **No provider, auth or routing configuration.** It mounts no service, registers no
  tool, and touches no endpoint or credential.
* **No cost control.** It cannot cap, cancel or budget anything — read the next section.
* **No server-side change.** If your gateway has its own idle-connection limit, this
  plugin will not help; ask your operator for SSE comment heartbeats instead.

## Cost and billing (please read)

The plugin makes **no network requests of its own** and adds no cost by itself. But it
changes the *outcome* of a stall, and that has a price:

* Before: the request was killed at ~304 s, and you paid for tokens you never received.
* After: the request keeps waiting while the provider keeps generating — and the
  provider bills those tokens. You now pay for output you actually receive, and the
  request may take minutes longer.
* Combined with an unlimited retry policy, repeated stalls can multiply token spend
  (most providers bill every failed attempt too). Budget accordingly, watch your usage
  dashboard, and prefer smaller outputs.
* The clocks are finite on purpose (30 min / 10 min): a genuinely dead peer is still
  reclaimed instead of hanging forever.

## Pairing with a retry policy (optional, not shipped)

Automatic retries belong to your profile patch
(`~/.dsh/profiles/<profile>/cordis.patch.yml`), not to this plugin. Example for a
provider route:

```yaml
providers:
  your-provider:
    retryPolicy:
      mode: always              # no retry cap; ignores retryableCodes
      backoff: { initialDelayMs: 5000, maxDelayMs: 300000, jitterRatio: 0.25 }
```

Choose delays that respect your provider's rate limit (institutional deployments often
have a small per-key RPM), and keep the cost note above in mind: **retries are billed**.

## Scope and caveats

* **Process-wide by design.** Every `fetch` in the DSH host process (all
  providers, other plugins) loses the 300 s default ceiling and inherits the
  configured one. That is the point, but it is a real blast radius.
* **Not a cure for upstream stalls.** If your provider pauses for minutes, the
  request still takes minutes. Pair this with a retry policy, and prefer smaller
  outputs so a stall costs less.
* **Client-side keepalive is not an option.** After an HTTP/1.1 POST body is sent,
  a client has no legal place to write on that request, and SSE is one-way
  (server → client). TCP keepalive and HTTP/2 PINGs only address transport-idle
  middleboxes. The only legitimate in-stream heartbeat is a **server-sent SSE
  comment** (`: ping`) — a server-side measure. This plugin is the client-side fix.
* Node only. It has no effect on Python/Go/Rust clients, which do not ship this
  default (a useful hint when a colleague "can run 700 s requests" and you cannot).

## How it was diagnosed

1. A non-streaming probe died at **t = 304.6 s** with `HeadersTimeoutError` —
   an **undici exception class**, which revealed the client-side clocks.
2. Every production failure was re-checked: silence gaps of **304.6–305.4 s**,
   `message: "terminated"`, always mid-stream, always after content started.
3. A local controlled reproduction (local SSE server, real Node fetch) reproduced
   the fingerprint exactly: last byte at `t = 2.045 s` → error at `t = 306.062 s`
   (`TypeError: terminated`, cause `BodyTimeoutError`, code `UND_ERR_BODY_TIMEOUT`),
   while a client built with `Agent({ bodyTimeout: 0 })` survived **338 s** of
   silence and completed the stream. `setGlobalDispatcher` from a differently
   versioned undici copy also fixed the built-in `fetch` — the injection path this
   plugin uses.

`scripts/reproduce-300s.mjs` ships that reproduction:

```bash
node scripts/reproduce-300s.mjs            # default fetch: reproduces the ~304 s kill
node scripts/reproduce-300s.mjs --plugin   # after this plugin: survives past 300 s
```

## Development

```bash
npm install
npm test
```

`npm test` runs a fast, deterministic pair:

* **control** — an `Agent` with a tiny `bodyTimeout` proves that a silent stream
  dies with `UND_ERR_BODY_TIMEOUT` (the reported failure shape);
* **fix** — after `apply()`, the same silence completes, and the global dispatcher
  is verified to be this plugin's agent;
* plus header-phase survival and idempotent re-mount checks.

## Provenance

Vibe-coded by the author, with **GLM 5.3** and **DeepSeek V4.1 Flash** driving the
investigation and the implementation. Every claim in this README is backed by scripts
in this repo (`npm test`, `scripts/reproduce-300s.mjs`) — run them yourself rather than
trusting the prose. See `LICENSE` for the same note.

## License

MIT. `undici` is a normal dependency (not vendored), so its own license stays with it.
