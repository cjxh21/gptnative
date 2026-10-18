/** Shared, atomic leases and durable jobs. No model or browser dependency. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, readdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

export const DATA_DIR = process.env.GPTWEB_DATA_DIR ?? join(homedir(), '.dsh', 'gptweb-browser')
const jobsDir = join(DATA_DIR, 'jobs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' }
}
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
export function leaseHolder(name) { return read(join(DATA_DIR, `${name}.lock`)) }
function tryLease(name) {
  mkdirSync(DATA_DIR, { recursive: true })
  const path = join(DATA_DIR, `${name}.lock`)
  const owner = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() }
  try { writeFileSync(path, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    // Serialize stale reclamation, then re-read under the reclamation lease.
    const gate = path + '.reclaim'
    try { mkdirSync(gate) } catch {
      try { if (Date.now() - statSync(gate).mtimeMs > 5000) rmdirSync(gate) } catch {}
      return null
    }
    try {
      const holder = read(path)
      let stale = holder?.pid ? !alive(holder.pid) : false
      if (!holder?.pid) { try { stale = Date.now() - statSync(path).mtimeMs > 5000 } catch {} }
      if (stale) { try { unlinkSync(path) } catch {} }
    } finally { try { rmdirSync(gate) } catch {} }
    return null
  }
  return { owner, release() { if (read(path)?.token === owner.token) { try { unlinkSync(path) } catch {} } } }
}
export async function acquireLease(name, { timeoutMs = 300000, pollMs = 100 } = {}) {
  const until = Date.now() + timeoutMs
  do {
    const lease = tryLease(name)
    if (lease) return lease
    if (Date.now() >= until) return null
    await sleep(pollMs)
  } while (true)
}
function jobPath(id) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('invalid-job-id')
  return join(jobsDir, `${id}.json`)
}
export function writeJob(id, patch) {
  mkdirSync(jobsDir, { recursive: true })
  const path = jobPath(id)
  const job = { ...(read(path) ?? {}), ...patch }
  const temp = path + '.' + randomUUID() + '.tmp'
  writeFileSync(temp, JSON.stringify(job, null, 1), { mode: 0o600 })
  renameSync(temp, path)
  return job
}
export function readJob(id) {
  const job = read(jobPath(id))
  if (job?.status === 'running' && job.pid && !alive(job.pid)) {
    return writeJob(id, { status: 'interrupted', finishedAt: new Date().toISOString(),
      result: { ok: false, error: 'worker-exited', detail: '网页可能已收到问题；不会自动重发。', submitted: 'unknown' } })
  }
  return job
}
export function listJobs() {
  let files = []
  try { files = readdirSync(jobsDir).filter(f => f.endsWith('.json')) } catch {}
  return files.map(f => readJob(f.slice(0, -5))).filter(Boolean).sort((a,b) => String(a.startedAt).localeCompare(String(b.startedAt)))
}
export function ensureWorker() {
  if (alive(leaseHolder('worker')?.pid)) return
  const child = spawn(process.execPath, [new URL('../bin/gptweb-browser', import.meta.url).pathname, 'worker'],
    { detached: true, stdio: 'ignore', env: process.env })
  child.unref()
}
export function submitJob(question, options) {
  const id = randomUUID().slice(0, 12)
  const job = writeJob(id, { id, question, options, status: 'queued', startedAt: new Date().toISOString(), pid: null })
  ensureWorker()
  return job
}
export async function runQueue(run, { idleMs = 2000 } = {}) {
  const lease = await acquireLease('worker', { timeoutMs: 1000 })
  if (!lease) return
  try {
    let emptySince = Date.now()
    while (Date.now() - emptySince < idleMs) {
      const job = listJobs().find(j => j.status === 'queued')
      if (!job) { await sleep(200); continue }
      emptySince = Date.now()
      writeJob(job.id, { status: 'running', phase: 'preparing', pid: process.pid, runningAt: new Date().toISOString() })
      let result
      try { result = await run(job, phase => writeJob(job.id, { phase })) }
      catch (error) { result = { ok: false, error: String(error?.message ?? error), submitted: 'unknown' } }
      writeJob(job.id, { status: result.ok ? 'done' : result.submitted === 'unknown' ? 'interrupted' : 'failed',
        phase: 'finished', finishedAt: new Date().toISOString(), result })
      emptySince = Date.now()
    }
  } finally {
    lease.release()
    // Covers an enqueue racing with worker shutdown.
    if (listJobs().some(j => j.status === 'queued')) ensureWorker()
  }
}
