# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Status of `1.0.0`:** initial release. It has **not** been published to npm yet, so
> install it from this repository in the meantime (README → Install → "From this
> repository"). And — as documented under "Validation status" in the README — it has not
> yet been exercised by a real-world 300+ s stall. The first genuine stall is the
> acceptance test.

## [1.0.0] - 2026-10-13

First release: a DSH host plugin that removes undici's default 300 s client clocks for
the whole host process, so a provider that stalls mid-stream no longer looks like a
provider that hung up.

### Added

- Host-side cordis fiber (`index.js`) that installs
  `setGlobalDispatcher(new Agent({ bodyTimeout: 1_800_000, headersTimeout: 600_000 }))`
  at mount time, covering every provider in the DSH host process
  (pi-ai → OpenAI SDK → `globalThis.fetch` → global undici dispatcher).
- Idempotent mount guard, plus a runtime marker `globalThis.__streamTimeoutFix`
  holding the installed agent, the effective timeouts, the applied timestamp and the
  Node/Electron versions.
- Configuration through the loader patch row (`bodyTimeoutMs`, `headersTimeoutMs`) or
  the environment (`DSH_STREAM_TIMEOUT_BODY_MS`, `DSH_STREAM_TIMEOUT_HEADERS_MS`);
  explicit options win over environment variables.
- Bundle manifest (`dsh.bundle.patch` → `cordis.patch.yml`) so
  `dsh plugin --profile <profile> add dsh-stream-timeout-fix` mounts the entry without
  hand-editing the profile patch.
- Test suite (`npm test`, `node --test`, 5 tests): a tiny `bodyTimeout` reproduces the
  exact failure shape (`TypeError: terminated` / `UND_ERR_BODY_TIMEOUT`), and the same
  silence completes after `apply()`; plus header-phase survival, idempotent re-mount and
  configuration precedence.
- `scripts/reproduce-300s.mjs`: the full ~304 s reproduction with the default dispatcher,
  and a `--plugin` mode that survives it.
- `scripts/audit-session-gaps.mjs`: measures the **true** inter-chunk gap of any DSH
  attempt by expanding the per-token timestamps (`time0` + cumulative `dt[]`) that DSH
  0.2.1+ records, lists attempts by largest gap, and reports how many reached ≥ 300 s.
  This is what separates "a long request" from "a stall that was survived".
- Bilingual documentation (English + 简体中文) with a language switcher.
- GitHub Actions CI on Node 22 and 24, with `prepublishOnly` gating `npm publish` on the
  test suite.

### Changed

- Renamed from `dsh-bundle-undici-clockfix` to **`dsh-stream-timeout-fix`**, together
  with the loader entry id (`stream-timeout-fix`), the log prefix
  (`[stream-timeout-fix]`), the runtime marker (`__streamTimeoutFix`), the environment
  variables and the test filename. The old name described the mechanism; the new one
  describes the symptom that brings people here.
- `undici` is now a normal npm dependency instead of a vendored copy of DSH's own
  bundle, with a fallback resolver for install layouts that skip dependencies
  (`link:` / checkout installs).
- Moved the model-provenance note out of `LICENSE` into `PROVENANCE.md`, so GitHub
  detects the MIT license correctly.
- Added `scripts/check-content-encoding.mjs` and wired it into `npm test`: it verifies
  that swapping the global dispatcher does **not** break content-encoding decoding on
  Node's built-in fetch, the cross-version trap reported upstream in discussions
  `#7721` / `#7671` / `#7598` / `#7468` / `#7502`. Passes on Node 24.21 with
  undici 8.11.2.

### Fixed

- CI: the Node 20 job failed because the `undici` dependency requires Node ≥ 22.19.0.
  The matrix is now 22/24 and `engines.node` mirrors the dependency, so older Node
  versions fail with a clear npm warning instead of a cryptic runtime error.

### Documentation

- "Who this is for": third-party / self-hosted OpenAI-compatible endpoints (university
  or company private deployments, LiteLLM-style gateways), plus a maintenance
  disclaimer — a personal-use project with no support commitment.
- "Validation status": proven by controlled local reproduction and the test suite, now
  with field data from 2026-10-13 → 2026-10-19 (structural count): the targeted
  `TRANSPORT` / `TypeError: terminated` / `UND_ERR_BODY_TIMEOUT` class did not recur;
  two >300 s silences were cut at exactly 300.02 s and 300.04 s by DSH's own watchdog
  (`pi-ai stream idle timeout after 300000ms`); a 314.23 s request completed with ~210 s
  of max silence, and a 756.84 s request on 2026-10-19 completed with a **2.6 s** max
  inter-chunk gap (continuous streaming — long, but not a stall). A full audit of
  **9,724 attempts** found **no** attempt with a ≥ 300 s gap; the largest ever measured
  is **277.0 s** (2026-10-12, before the plugin, and it succeeded) against the nine
  pre-fix failures at **304.6–305.4 s** — a bracket around undici's 300 s default.
- "Raise `streamIdleTimeoutMs` as well": documents that this plugin only removes
  undici's clocks, and that the per-route `streamIdleTimeoutMs` (default `300000`) must
  be raised too before a >300 s silence can survive — otherwise only the error code
  improves (honest `TIMEOUT` instead of `TRANSPORT`).
- "The four clocks that can cut a stream": `headersTimeout` / `bodyTimeout` (this
  plugin), `streamIdleTimeoutMs` and `timeoutMs` (`dsh-llm-pi-ai` → openai SDK, default
  600 s, surfaces as `Request timed out.` / `TIMEOUT` in the headers phase). Field
  evidence from 2026-10-28: one attempt survived a **607.1 s** mid-stream silence with no
  retry (754.0 s, `tool-calls`) — the first witnessed >300 s survival — while another
  died at **600.043 s** on the SDK `timeoutMs`, which the platform logged as `499` +
  failure.
- "What this plugin does not do" (no retry logic, no provider/auth/routing
  configuration, no cost control, no stream-watchdog change) and "Cost and billing": a
  surviving stall keeps the provider generating and billing, and unlimited retries
  multiply token spend.
- "Pairing with a retry policy (optional, not shipped)" with a profile-patch example.
- "Provenance": vibe-coded with GLM 5.3 and DeepSeek V4.1 Flash — see
  [PROVENANCE.md](PROVENANCE.md).

[1.0.0]: https://github.com/SundaeYAGO/dsh-stream-timeout-fix/releases/tag/v1.0.0
