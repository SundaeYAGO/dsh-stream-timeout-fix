// Cross-version check: does replacing the global undici dispatcher (this plugin's
// mechanism, an `undici` npm Agent) break anything for Node's BUILT-IN fetch?
//
// Upstream reports an entire family of bugs where DSH's outbound-proxy plugin put a
// userland undici 8.x dispatcher into the process-global slot and Node's built-in
// fetch (bundled undici 7.x) then lost content-encoding decompression / response
// headers:
//   deepseek-ai/deepseek-harness discussions #7721, #7671, #7598, #7468, #7502
// Our plugin swaps the same slot, so this must be verified, not assumed.
//
// Run: node scripts/check-content-encoding.mjs
// Exits non-zero if gzip decoding breaks after the dispatcher swap.
import http from 'node:http'
import zlib from 'node:zlib'

const pluginEntry = new URL('../index.js', import.meta.url)
const payload = JSON.stringify({ ok: true, pad: 'x'.repeat(2000) })

const server = http.createServer((req, res) => {
  const wantGzip = req.url.startsWith('/gzip')
  const body = wantGzip ? zlib.gzipSync(payload) : Buffer.from(payload)
  res.writeHead(200, {
    'content-type': 'application/json',
    ...(wantGzip ? { 'content-encoding': 'gzip' } : {}),
  })
  res.end(body)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/`

async function probe(label) {
  let failures = 0
  for (const path of ['plain', 'gzip']) {
    try {
      const response = await fetch(base + path, { headers: { 'accept-encoding': 'gzip' } })
      const text = await response.text()
      const ok = text === payload
      if (!ok) failures += 1
      console.log(
        `${label} /${path.padEnd(5)} status=${response.status} ` +
        `${ok ? 'decoded OK' : `BROKEN (len=${text.length}, head=${JSON.stringify(text.slice(0, 30))})`}`,
      )
    } catch (error) {
      failures += 1
      console.log(`${label} /${path.padEnd(5)} ERROR ${error.message} | cause=${error.cause?.code ?? '-'}`)
    }
  }
  return failures
}

console.log(`node ${process.version} | built-in undici ${process.versions.undici}`)
let failures = await probe('[before plugin]')

const { default: apply } = await import(pluginEntry.href)
await apply({ logger: { info: () => {} } })
const applied = globalThis.__streamTimeoutFix
console.log(`[plugin] node ${applied?.node} | bodyTimeout=${applied?.bodyTimeoutMs} headersTimeout=${applied?.headersTimeoutMs}`)

const vendored = await import(new URL('../node_modules/undici/package.json', import.meta.url), { with: { type: 'json' } })
console.log(`[plugin] dispatcher from undici ${vendored.default.version} (built-in fetch uses undici ${process.versions.undici})`)
failures += await probe('[after plugin ]')

server.close()
console.log(failures === 0 ? '\nVERDICT: content-encoding survives the swap' : `\nVERDICT: ${failures} broken case(s) — cross-version trap is REAL`)
process.exit(failures === 0 ? 0 : 1)
