/**
 * dsh-stream-timeout-fix — a DSH (DeepSeek Harness) host-side plugin.
 *
 * THE PROBLEM
 * Node's built-in fetch runs on undici, which ships two client-side clocks that
 * stay invisible until they fire:
 *
 *   headersTimeout = 300_000 ms   time allowed until the first response byte
 *   bodyTimeout    = 300_000 ms   idle gap BETWEEN body bytes (re-armed by every byte)
 *
 * LLM endpoints (API gateways, LiteLLM-style proxies, self-hosted vLLM, ...)
 * occasionally stall mid-stream: the SSE response is established and content has
 * already started flowing, then nothing arrives for minutes while the upstream
 * keeps generating. Once that silence passes 300 s, `bodyTimeout` destroys the
 * socket and the reader (pi-ai / OpenAI SDK / any fetch consumer) throws:
 *
 *   TypeError: terminated        (cause: BodyTimeoutError, UND_ERR_BODY_TIMEOUT)
 *
 * That message reads exactly like "the server hung up on us", so the failure is
 * easily misattributed to the provider — while the provider's own logs show a
 * client-side disconnect (LiteLLM/nginx `499`) and the upstream still bills the
 * tokens it generated. Measured fingerprint: death after ~304-305 s of silence,
 * always after content started flowing, never during the headers phase.
 *
 * THE FIX
 * Install a process-global undici dispatcher whose clocks tolerate long silent
 * gaps. DSH's LLM path (dsh-llm-pi-ai -> pi-ai -> OpenAI SDK v6 -> globalThis
 * fetch -> global dispatcher) never passes a custom fetch, so replacing the
 * global dispatcher covers every provider in the host process at once.
 *
 * This does not resurrect a dead connection: it only stops OUR client from
 * killing a connection the provider is still working on. Stream-level watchdogs
 * (e.g. pi-ai's `streamIdleTimeoutMs`) and provider retry policies remain the
 * real guards — this plugin just stops two clocks from disagreeing about what
 * "idle" means.
 *
 * THIS PLUGIN SHIPS NO RETRY LOGIC and talks to no endpoint. It also cannot cap
 * or predict cost — but it does change the outcome of a stall: the provider keeps
 * generating (and billing) instead of the request dying at 300 s. Read
 * "Cost and billing" in README.md before installing.
 *
 * VALIDATION: proven by controlled local reproduction and this repo's tests only.
 * No real 300+ s stall has been observed since installation — the first genuine
 * stall is the acceptance test. See "Validation status" in README.md.
 *
 * Defaults are deliberately finite rather than 0, so a genuinely dead peer is
 * still reclaimed eventually:
 *
 *   bodyTimeoutMs      1_800_000 (30 min)   env DSH_STREAM_TIMEOUT_BODY_MS
 *   headersTimeoutMs     600_000 (10 min)   env DSH_STREAM_TIMEOUT_HEADERS_MS
 *
 * Both can also be set per entry in the loader patch row:
 *
 *   - id: stream-timeout-fix
 *     name: 'dsh-stream-timeout-fix'
 *     config: { bodyTimeoutMs: 0, headersTimeoutMs: 600000 }
 *
 * SCOPE: the swap is process-wide — it affects `globalThis.fetch` and every
 * undici user in the host process, intentionally. Worth knowing when reasoning
 * about other plugins' network calls.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'dsh-stream-timeout-fix'

/** Load undici, with a best-effort fallback for installs that skip dependencies. */
async function loadUndici() {
  try {
    return await import('undici')
  } catch (err) {
    // `link:` / checkout installs do not install a linked package's
    // dependencies. Fall back to the undici copy DSH itself ships.
    const candidates = []
    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', 'undici', 'index.js'),
        path.join(process.resourcesPath, 'app', 'dsh', 'node_modules', 'undici', 'index.js'),
      )
    }
    for (const file of candidates) {
      try {
        return await import(pathToFileURL(file).href)
      } catch {
        // try the next candidate
      }
    }
    const error = new Error(
      `[stream-timeout-fix] cannot load undici (${err?.message ?? err}); ` +
      'install this package together with its dependencies so that "undici" resolves.',
    )
    error.cause = err
    throw error
  }
}

function resolveTimeouts(opts) {
  const fromEnv = (key, fallback) => {
    const value = Number.parseInt(process.env[key] ?? '', 10)
    return Number.isFinite(value) && value >= 0 ? value : fallback
  }
  const bodyTimeoutMs = Number.isFinite(opts?.bodyTimeoutMs) && opts.bodyTimeoutMs >= 0
    ? opts.bodyTimeoutMs
    : fromEnv('DSH_STREAM_TIMEOUT_BODY_MS', 1_800_000)
  const headersTimeoutMs = Number.isFinite(opts?.headersTimeoutMs) && opts.headersTimeoutMs >= 0
    ? opts.headersTimeoutMs
    : fromEnv('DSH_STREAM_TIMEOUT_HEADERS_MS', 600_000)
  return { bodyTimeoutMs, headersTimeoutMs }
}

export async function apply(ctx, opts) {
  const log = ctx?.logger?.info ? ctx.logger : console
  if (globalThis.__streamTimeoutFix?.agent) {
    log.info('[stream-timeout-fix] already applied in this process; skipping re-mount')
    return
  }
  const { Agent, setGlobalDispatcher } = await loadUndici()
  const { bodyTimeoutMs, headersTimeoutMs } = resolveTimeouts(opts)
  const agent = new Agent({ bodyTimeout: bodyTimeoutMs, headersTimeout: headersTimeoutMs })
  setGlobalDispatcher(agent)
  globalThis.__streamTimeoutFix = {
    agent,
    bodyTimeoutMs,
    headersTimeoutMs,
    appliedAt: new Date().toISOString(),
    node: process.version,
    electron: process.versions?.electron ?? 'none',
  }
  log.info(
    `[stream-timeout-fix] global dispatcher replaced: bodyTimeout=${bodyTimeoutMs}ms, ` +
    `headersTimeout=${headersTimeoutMs}ms (undici defaults are 300000/300000); ` +
    `node=${process.version} electron=${globalThis.__streamTimeoutFix.electron}`,
  )
}

export default apply
