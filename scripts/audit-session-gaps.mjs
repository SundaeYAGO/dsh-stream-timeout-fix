// Audit a DSH session log for silence gaps in LLM streams.
//
// Why this exists: a "long request" is not evidence that a *stall* was survived.
// undici's bodyTimeout (and pi-ai's streamIdleTimeoutMs) only care about the gap
// between consecutive bytes, so a stream that flows continuously can run for hours
// even with 300 s ceilings. To prove this plugin did something, you need a session
// where the **maximum inter-chunk gap exceeded 300 s** and the attempt still finished.
//
// DSH 0.2.1+ records per-token timestamps (items of type `reasoning-chunks` /
// `text-chunks` carrying `time0` + cumulative `dt[]`), so gaps can be measured
// exactly. Older sessions only carry block markers (`block-start` / `block-end`),
// where a gap between markers is a phase boundary, not necessarily silence — this
// script reports how many stamps it found so you can tell which case you have.
//
// Usage:
//   node scripts/audit-session-gaps.mjs <session.v4.jsonl.zstd | directory> [--top=10] [--min-gap-s=0]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decode(file) {
  const raw = readFileSync(file)
  const parts = []
  let off = 0
  while (off < raw.length) {
    try { parts.push(zstdDecompressSync(raw.subarray(off))) } catch { break }
    const next = raw.indexOf(MAGIC, off + 4)
    if (next === -1) break
    off = next
  }
  return Buffer.concat(parts).toString('utf8')
}

function walk(p) {
  if (statSync(p).isFile()) return [p]
  const out = []
  for (const name of readdirSync(p)) {
    const full = join(p, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.jsonl.zstd')) out.push(full)
  }
  return out
}

const args = process.argv.slice(2)
const target = args.find((a) => !a.startsWith('--'))
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.split('=')[1]) : dflt
}
if (!target) {
  console.error('usage: node scripts/audit-session-gaps.mjs <session.v4.jsonl.zstd | dir> [--top=10] [--min-gap-s=0]')
  process.exit(1)
}
const TOP = opt('top', 10)
const MIN_GAP = opt('min-gap-s', 0)

const local = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + '.' + String(Math.round(ms) % 1000).padStart(3, '0')

const rows = []
for (const file of walk(target)) {
  const events = decode(file).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const starts = new Map()
  for (const e of events) {
    if (e.type === 'step/start' && Number.isFinite(e.data?.turn) && Number.isFinite(e.data?.step)) {
      starts.set(`${e.data.turn}/${e.data.step}`, e.time)
    }
  }
  const attempts = new Map()
  for (const e of events) {
    if (e.type !== 'assistant/message' || !Array.isArray(e.data?.stream)) continue
    const key = `${e.data.turn}/${e.data.step}`
    const times = []
    let perToken = 0
    let finish
    for (const item of e.data.stream) {
      if (Array.isArray(item.dt) && typeof item.time0 === 'number') {
        let acc = item.time0
        times.push(acc)
        for (const d of item.dt) { acc += d; times.push(acc) }
        perToken += item.dt.length + 1
        continue
      }
      if (typeof item.time === 'number') times.push(item.time)
      const reason = item.chunk?.type === 'finish' ? item.chunk.reason : undefined
      if (reason) finish = reason
    }
    if (times.length) attempts.set(key, { times, perToken, finish, at: e.time })
  }
  for (const [key, a] of attempts) {
    a.times.sort((x, y) => x - y)
    let maxGap = 0
    let where = null
    for (let i = 1; i < a.times.length; i++) {
      const gap = (a.times[i] - a.times[i - 1]) / 1000
      if (gap > maxGap) { maxGap = gap; where = [a.times[i - 1], a.times[i]] }
    }
    const requestAt = starts.get(key)
    rows.push({
      file: file.split(/[\\/]/).slice(-2, -1)[0],
      key,
      requestAt,
      firstChunkDelayS: requestAt ? (a.times[0] - requestAt) / 1000 : null,
      maxGapS: maxGap,
      where,
      stamps: a.times.length,
      perToken: a.perToken,
      outcome: a.finish?.kind === 'error' ? `ERROR ${a.finish.failure?.code}: ${a.finish.failure?.message}` : (a.finish?.kind ?? 'none'),
      end: a.times[a.times.length - 1],
    })
  }
}

rows.sort((a, b) => b.maxGapS - a.maxGapS)
const shown = rows.filter((r) => r.maxGapS >= MIN_GAP).slice(0, TOP)
console.log(`attempts found: ${rows.length}; showing ${shown.length} by max inter-chunk gap (min-gap-s=${MIN_GAP})`)
console.log('session | turn/step | request | first chunk | MAX GAP | stamps | outcome')
for (const r of shown) {
  console.log(
    `${r.file} | ${r.key.padEnd(6)} | ${r.requestAt ? local(r.requestAt) : '?'} | ` +
    `${r.firstChunkDelayS == null ? '?' : r.firstChunkDelayS.toFixed(1) + 's'} | ` +
    `${r.maxGapS.toFixed(1).padStart(8)}s | ${String(r.stamps).padStart(6)}${r.perToken ? ' (per-token)' : ' (block-level)'} | ${r.outcome}`,
  )
  if (r.where) console.log(`    gap ${local(r.where[0])} -> ${local(r.where[1])}`)
}
const over = rows.filter((r) => r.maxGapS >= 300)
console.log(`\nattempts with a gap >= 300 s: ${over.length}`)
for (const r of over) console.log(`  ${r.key} in ${r.file}: ${r.maxGapS.toFixed(1)}s, outcome=${r.outcome}`)
