/**
 * Fast, deterministic proof of the fix.
 *
 * The real-world failure needs 300 s of silence, which is useless in CI. So the
 * control cases recreate the SAME mechanism with a tiny timeout: a stream that
 * dies with UND_ERR_BODY_TIMEOUT after 400 ms dies the same way after 300 s —
 * same clock, same error shape (`TypeError: terminated`).
 *
 * Two Node-fetch details shaped this file:
 *
 * 1. Call the plugin as `activate(ctx, opts)`. On a *default* import,
 *    `mod.apply(...)` is Function.prototype.apply, which invokes the plugin with
 *    zero arguments and silently drops ctx and opts. (The namespace import is
 *    safe; cordis calls the exported `apply` correctly itself.)
 * 2. A dispatcher created from the `undici` package cannot be passed through
 *    `fetch(url, { dispatcher })` to Node's built-in fetch — it rejects with
 *    UND_ERR_INVALID_ARG, because the built-in fetch only accepts dispatchers
 *    from its own bundled undici. Injecting through `setGlobalDispatcher` works
 *    across copies (that shared symbol slot is exactly what this plugin uses).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import activate from '../index.js'

const silentLogger = { info() {}, warn() {}, error() {} }

/** The plugin's agent, captured so later tests can restore it. */
let pluginAgent

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

/** SSE server: `before` chunks at once, then a silent gap, then `after` chunks + EOF. */
function sseServer({ silenceMs, before = 2, after = 2 }) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    let sent = 0
    while (sent < before) res.write(`data: chunk-${++sent}\n\n`)
    setTimeout(() => {
      while (sent < before + after) res.write(`data: chunk-${++sent}\n\n`)
      res.end()
    }, silenceMs)
  })
  return listen(server)
}

/** Server that delays its response headers. */
function delayedHeaderServer({ delayMs }) {
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    }, delayMs)
  })
  return listen(server)
}

async function readAll(response) {
  // Chunks are Uint8Array; decode before concatenating.
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of response.body) {
    text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

test('control: undici bodyTimeout kills a silent mid-stream response (the reported failure shape)', async () => {
  const server = await sseServer({ silenceMs: 1200 })
  const control = new Agent({ bodyTimeout: 400, headersTimeout: 400 })
  setGlobalDispatcher(control) // the same injection path the plugin uses
  try {
    await assert.rejects(
      (async () => readAll(await fetch(server.url)))(),
      (error) => {
        assert.equal(error.name, 'TypeError')
        assert.match(error.message, /terminated/)
        assert.equal(error.cause?.name, 'BodyTimeoutError')
        assert.equal(error.cause?.code, 'UND_ERR_BODY_TIMEOUT')
        return true
      },
    )
  } finally {
    await control.close()
    await server.close()
  }
})

test('fix: after apply(), the same silence completes and the global dispatcher is ours', async () => {
  await activate({ logger: silentLogger })
  const applied = globalThis.__streamTimeoutFix
  assert.ok(applied?.agent, 'runtime marker is set')
  assert.equal(applied.bodyTimeoutMs, 1_800_000)
  assert.equal(applied.headersTimeoutMs, 600_000)
  assert.equal(getGlobalDispatcher(), applied.agent, 'built-in fetch now uses the plugin agent')
  pluginAgent = applied.agent

  const server = await sseServer({ silenceMs: 1200 })
  try {
    // No dispatcher option here: this is plain global fetch, mid-silence.
    const events = (await readAll(await fetch(server.url))).split('\n\n').filter(Boolean)
    assert.deepEqual(events, ['data: chunk-1', 'data: chunk-2', 'data: chunk-3', 'data: chunk-4'])
  } finally {
    await server.close()
  }
})

test('headers phase: control dies quickly, plugin agent survives', async () => {
  const server = await delayedHeaderServer({ delayMs: 1200 })
  const control = new Agent({ headersTimeout: 400, bodyTimeout: 400 })
  setGlobalDispatcher(control)
  try {
    await assert.rejects(
      fetch(server.url),
      (error) => {
        assert.match(error.message, /fetch failed/)
        assert.equal(error.cause?.name, 'HeadersTimeoutError')
        assert.equal(error.cause?.code, 'UND_ERR_HEADERS_TIMEOUT')
        return true
      },
    )
  } finally {
    await control.close()
    setGlobalDispatcher(pluginAgent) // back to the plugin's tolerant clock
  }
  try {
    const response = await fetch(server.url)
    assert.equal(await response.text(), 'ok')
  } finally {
    await server.close()
  }
})

test('re-mount is a no-op (idempotent)', async () => {
  const first = globalThis.__streamTimeoutFix.agent
  await activate({ logger: silentLogger }, { bodyTimeoutMs: 1, headersTimeoutMs: 1 })
  assert.equal(globalThis.__streamTimeoutFix.agent, first)
  assert.equal(globalThis.__streamTimeoutFix.bodyTimeoutMs, 1_800_000)
})

test('configuration: env vars are honored, explicit opts win', async () => {
  const previous = [process.env.DSH_STREAM_TIMEOUT_BODY_MS, process.env.DSH_STREAM_TIMEOUT_HEADERS_MS]
  try {
    delete globalThis.__streamTimeoutFix
    process.env.DSH_STREAM_TIMEOUT_BODY_MS = '1234'
    process.env.DSH_STREAM_TIMEOUT_HEADERS_MS = '5678'
    await activate({ logger: silentLogger })
    assert.equal(globalThis.__streamTimeoutFix.bodyTimeoutMs, 1234)
    assert.equal(globalThis.__streamTimeoutFix.headersTimeoutMs, 5678)
    pluginAgent = globalThis.__streamTimeoutFix.agent

    delete globalThis.__streamTimeoutFix
    await activate({ logger: silentLogger }, { bodyTimeoutMs: 99, headersTimeoutMs: 98 })
    assert.equal(globalThis.__streamTimeoutFix.bodyTimeoutMs, 99)
    assert.equal(globalThis.__streamTimeoutFix.headersTimeoutMs, 98)
    assert.equal(getGlobalDispatcher(), globalThis.__streamTimeoutFix.agent)
  } finally {
    for (const [key, value] of [
      ['DSH_STREAM_TIMEOUT_BODY_MS', previous[0]],
      ['DSH_STREAM_TIMEOUT_HEADERS_MS', previous[1]],
    ]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
