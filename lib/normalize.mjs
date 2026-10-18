/**
 * normalize.mjs —— 会话 JSON 转人可读 Markdown。
 *
 * 从 dsh-gptweb-bridge/lib/websync.js 抽离 normalizeConversation 及其文件清单依赖。
 * 关键改动：不再 import browser.js（原实现会连带引入 patchright 浏览器依赖），
 * files.json 清单改为按传入的库根目录读取，保持与原实现相同的回退行为。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isAppArchive, normalizeAppArchive, libraryRoot } from './local-library.mjs'
import { NATIVE_ANSWER_SCHEMA, normalizeNativeAnswer } from './native-library.mjs'

const FILES_MANIFEST = (root) => join(root, 'files.json')

/** 读取附件清单；缺失或损坏时回退为空清单，与 websync 原行为一致。 */
export function readFilesManifest(root = libraryRoot()) {
  try { return JSON.parse(readFileSync(FILES_MANIFEST(root), 'utf8')) } catch { return { files: {} } }
}

/** 按 current_node 回溯出当前分支，转成人可读 markdown。 */
export function normalizeConversation(conv, { root = libraryRoot() } = {}) {
  if (isAppArchive(conv)) return normalizeAppArchive(conv)
  if (conv?.schema === NATIVE_ANSWER_SCHEMA) return normalizeNativeAnswer(conv)
  const mapping = conv.mapping || {}
  const path = []
  const seen = new Set()
  let node = conv.current_node
  while (node && mapping[node] && !seen.has(node)) {
    seen.add(node)
    path.push(node)
    node = mapping[node].parent
  }
  path.reverse()

  const fmt = (t) => {
    const n = Number(t)
    if (!Number.isFinite(n) || n <= 0) return String(t ?? '-')
    return new Date(n * 1000).toISOString().replace('T', ' ').slice(0, 16)
  }
  const lines = [
    `# ${conv.title || '(无标题)'}`,
    '',
    `- id: ${conv.conversation_id ?? conv.id ?? ''}`,
    `- 创建: ${fmt(conv.create_time)}`,
    `- 更新: ${fmt(conv.update_time)}`,
    `- 节点总数: ${Object.keys(mapping).length}（当前分支 ${path.length}）`,
    `- 模型: ${conv.default_model_slug ?? '-'}`,
    '',
  ]
  const filesManifest = readFilesManifest(root)
  const fileLink = (fileId, fallbackName) => {
    const entry = filesManifest.files?.[fileId]
    if (!entry) return `\`${fileId}\`（未下载：websync files）`
    const rel = `files/${entry.path.split('/').pop()}`
    const label = entry.name ?? fallbackName ?? fileId
    return entry.mime?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(rel)
      ? `![${label}](${rel})`
      : `[${label}](${rel})`
  }

  for (const id of path) {
    const message = mapping[id]?.message
    if (!message) continue
    const role = message.author?.role
    if (role !== 'user' && role !== 'assistant') continue
    const content = message.content ?? {}
    const type = content.content_type
    // thoughts / reasoning_recap / tool 只在 raw 里保留，人读版不铺开
    if (type !== undefined && type !== 'text' && type !== 'multimodal_text') continue
    const chunks = []
    for (const part of content.parts ?? []) {
      if (typeof part === 'string') { if (part.trim() !== '') chunks.push(part.trim()); continue }
      if (part && typeof part === 'object' && typeof part.asset_pointer === 'string') {
        chunks.push(fileLink(part.asset_pointer.replace(/^sediment:\/\//, ''), part.name))
      }
    }
    const text = chunks.join('\n\n').trim()
    if (text === '') continue
    lines.push(role === 'user' ? '## 我' : '## ChatGPT', '', text, '')
    // 附件（metadata.attachments）也列出来
    const atts = (message.metadata?.attachments ?? []).filter(a => a?.id)
    if (atts.length > 0) {
      lines.push('附件：')
      for (const a of atts) lines.push(`- ${fileLink(a.id, a.name)}`)
      lines.push('')
    }
  }
  return lines.join('\n')
}
