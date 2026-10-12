#!/usr/bin/env node
/**
 * Reproduce the real-world fingerprint (takes ~5.5 minutes — run it manually).
 *
 *   node scripts/reproduce-300s.mjs            # default undici dispatcher -> killed at ~304s
 *   node scripts/reproduce-300s.mjs --plugin   # with this plugin -> survives past 300s
 *
 * The local server sends two SSE chunks, goes silent, then finishes. With the
 * default dispatcher the client dies ~304 s after the last byte with
 * `TypeError: terminated` / `UND_ERR_BODY_TIMEOUT` — the exact production shape.
 * Anything clearly different from ~304 s (say 120 s or 600 s) means you are
 * looking at a server/gateway idle limit instead of this client clock.
 *
 * Env overrides: RESUME_AFTER_MS, BUDGET_MS.
 */
import http from 'node:http'

const withPlugin = process.argv.includes('--plugin')
const resumeAfterMs = Number(process.env.RESUME_AFTER_MS ?? (withPlugin ? 320_000 : 400_000))
const budgetMs = Number(process.env.BUDGET_MS ?? (withPlugin ? 420_000 : 330_000))

const startedAt = Date.now()
let lastByteAt = startedAt
const t = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`

if (withPlugin) {
  const { apply } = await import('../index.js')
  await apply({ logger: { info: (message) => console.log(`[${t()}] ${message}`) } })
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  res.write('data: chunk-1\n\n')
  res.write('data: chunk-2\n\n')
  console.log(`[${t()}] server: 2 chunks sent, now silent for ${(resumeAfterMs / 1000).toFixed(0)}s`)
  setTimeout(() => {
    console.log(`[${t()}] server: resuming`)
    res.write('data: chunk-3\n\n')
    res.end()
  }, resumeAfterMs)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`

const watchdog = setTimeout(() => {
  console.log(`[${t()}] WATCHDOG: no verdict within ${(budgetMs / 1000).toFixed(0)}s`)
  process.exit(2)
}, budgetMs)
watchdog.unref?.()

try {
  const response = await fetch(url) // default global dispatcher unless --plugin
  console.log(`[${t()}] client: headers received (status ${response.status}), reading body`)
  let chunks = 0
  let bytes = 0
  for await (const chunk of response.body) {
    lastByteAt = Date.now()
    chunks += 1
    bytes += chunk.length
  }
  console.log(`[${t()}] STREAM COMPLETED: ${chunks} chunks, ${bytes} bytes`)
  console.log(withPlugin ? '[verdict] SURVIVED — the fix works.' : '[unexpected] default dispatcher survived?')
  process.exit(withPlugin ? 0 : 1)
} catch (error) {
  const gap = ((Date.now() - lastByteAt) / 1000).toFixed(1)
  console.log(`[${t()}] FAILED — ${gap}s after the last byte`)
  console.log(`        ${error?.name}: ${error?.message}`)
  console.log(`        cause: ${error?.cause?.name ?? '-'} (${error?.cause?.code ?? '-'})`)
  if (withPlugin) {
    console.log('[verdict] FAILED even with the plugin — check the gap above against 304-305s.')
    process.exit(1)
  }
  console.log('[verdict] REPRODUCED — this is the default-undici failure shape.')
  process.exit(0)
} finally {
  server.close()
}
