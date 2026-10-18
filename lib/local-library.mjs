/** App-visible ChatGPT text archive. No browser, network, credentials, or model. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { acquireLease } from './runtime.mjs'

export const APP_ARCHIVE_SCHEMA = 'chatgpt-app-library/v1'
export const libraryRoot = () => process.env.WEBSYNC_DIR ?? join(homedir(), 'Documents', 'ChatGPT', 'websync')
export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback
  // A damaged existing index must never silently turn into an empty index.
  return JSON.parse(readFileSync(path, 'utf8'))
}
function atomicJson(path, value) { atomicText(path, JSON.stringify(value, null, 1) + '\n') }
function atomicText(path, text) {
  const temp = path + '.' + randomUUID() + '.tmp'
  writeFileSync(temp, text, { flag: 'wx', mode: 0o600 })
  renameSync(temp, path)
}
export function isAppArchive(value) { return value?.schema === APP_ARCHIVE_SCHEMA }
export function normalizeAppArchive(archive) {
  const lines = [`# ${archive.thread.title || '(无标题)'}`, '',
    `- id: ${archive.thread.id}`, '- 来源: ChatGPT App',
    '- 导出范围: App 可读的当前分支文字；不包含原始消息树、隐藏推理或附件文件。',
    `- 最近导入覆盖全部可读历史: ${archive.coverage.lastImportComplete ? '是' : '否'}`,
    `- 文字发生截断: ${archive.coverage.textTruncated ? '是' : '否'}`, '']
  for (const turn of archive.turns) for (const item of turn.items ?? []) {
    const text = item.type === 'userMessage'
      ? (item.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n\n')
      : item.type === 'agentMessage' ? item.text : null
    if (!text?.trim()) continue
    lines.push(item.type === 'userMessage' ? '## 我' : '## ChatGPT', '', text, '')
  }
  return lines.join('\n')
}
export function reconcileBrowserListing(known, listed) {
  let missing = 0
  for (const id of Object.keys(known)) {
    // A browser account's list is not authoritative for App-imported data.
    if (['chatgpt-app', 'chatgpt-native'].includes(known[id].origin)) continue
    if (!listed.has(id)) { if (!known[id].deleted) { known[id].deleted = true; missing++ } }
    else if (known[id].deleted) known[id].deleted = false
  }
  return missing
}

export async function archiveAppThread(snapshot, { root = libraryRoot(), complete = false, agentTurn = null } = {}) {
  const thread = snapshot?.thread
  if (thread?.kind !== 'chatgpt' || !/^[0-9a-f-]{36}$/i.test(thread.id)) throw Error('Only a verified ChatGPT thread can be archived')
  for (const d of [root, join(root, 'raw'), join(root, 'normalized'), join(root, 'agent')]) mkdirSync(d, { recursive: true, mode: 0o700 })
  const lease = await acquireLease('websync', { timeoutMs: 10000 })
  if (!lease) throw Error('Local library busy; answer must not be resent. Retry archiving or sync-chat only.')
  try {
    const id = `app-${thread.id}`
    const rawPath = join(root, 'raw', id + '.json'), mdPath = join(root, 'normalized', id + '.md')
    const indexPath = join(root, 'index.json')
    const index = readJson(indexPath, { conversations: {}, counts: {}, lastSync: null })
    if (!index || typeof index.conversations !== 'object' || Array.isArray(index.conversations) || index.conversations === null) throw Error('Invalid local library index; no overwrite performed')
    const prior = readJson(rawPath, null)
    if (prior && !isAppArchive(prior)) throw Error('Archive path already contains another data format')
    if (prior && Number(prior.thread.updatedAt) > Number(thread.updatedAt)) return { ok: true, id, skipped: 'older-snapshot', raw: rawPath, md: mdPath }
    const turns = new Map((prior?.turns ?? []).map(t => [t.id, t]))
    for (const turn of [...(snapshot.turns ?? [])].reverse()) {
      const old = turns.get(turn.id)
      if (old?.items?.some(i => i.type === 'agentMessage') && !turn.items?.some(i => i.type === 'agentMessage')) continue
      turns.set(turn.id, turn)
    }
    const ordered = [...turns.values()].sort((a,b) => Number(a.startedAt ?? 0) - Number(b.startedAt ?? 0))
    const textTruncated = ordered.some(t => t.items?.some(i => i.truncated || i.content?.some(c => c.truncated)))
    const now = new Date().toISOString()
    const archive = { schema: APP_ARCHIVE_SCHEMA, origin: 'chatgpt-app', thread,
      account: { source: 'active-desktop-session', identityVerified: false },
      sessionPolicy: 'existing-chat', importedAt: now,
      coverage: { lastImportComplete: complete, lastFullImportAt: complete ? now : prior?.coverage.lastFullImportAt ?? null,
        textTruncated, rawTreeAvailable: false, attachmentFilesExported: false }, turns: ordered }
    atomicJson(rawPath, archive)
    atomicText(mdPath, normalizeAppArchive(archive))
    index.conversations[id] = { title: thread.title ?? '', create_time: thread.createdAt ?? '', update_time: thread.updatedAt ?? '',
      deleted: false, synced_at: now, origin: 'chatgpt-app', source_id: thread.id, format: APP_ARCHIVE_SCHEMA }
    index.counts = { ...(index.counts ?? {}), local: Object.keys(index.conversations).length,
      nativeApp: Object.values(index.conversations).filter(c => c.origin === 'chatgpt-app').length }
    index.lastNativeAppSync = now
    atomicJson(indexPath, index)
    if (agentTurn) {
      const path = join(root, 'agent', now.slice(0,10) + '.jsonl')
      const recordId = `chatgpt-app:${thread.id}:${agentTurn.turnId}`
      const existing = existsSync(path) ? readFileSync(path,'utf8').split('\n').some(line => { try { return JSON.parse(line).recordId === recordId } catch { return false } }) : false
      if (!existing) appendFileSync(path, JSON.stringify({ ts: now, origin: 'app-agent', recordId,
        conversationId: thread.id, sessionPolicy: 'existing-chat', ok: true, ...agentTurn }) + '\n', { mode: 0o600 })
    }
    return { ok: true, id, raw: rawPath, md: mdPath, turns: ordered.length, complete, textTruncated }
  } finally { lease.release() }
}
