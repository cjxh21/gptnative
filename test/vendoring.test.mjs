import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const here = join(testDir, '..')
const read = (f) => readFileSync(join(here, f), 'utf8')
const load = (f) => import(pathToFileURL(join(here, f)).href)

test('no cross-repository relative imports remain', () => {
  const files = [...readdirSync(join(here, 'lib')).map(f => join('lib', f)), 'native-cli.mjs', 'native-jobs.mjs']
  for (const f of files) {
    assert.ok(!read(f).includes('../../default-workspace/'), f + ' still imports across repositories')
  }
})

test('all vendored modules load and export expected symbols', async () => {
  const runtime = await load('lib/runtime.mjs')
  assert.equal(typeof runtime.acquireLease, 'function')
  const normalize = await load('lib/normalize.mjs')
  assert.equal(typeof normalize.normalizeConversation, 'function')
  const storage = await load('lib/storage.mjs')
  assert.equal(typeof storage.AccountStore, 'function')
  const nativeLib = await load('lib/native-library.mjs')
  assert.equal(typeof nativeLib.archiveNativeAnswer, 'function')
  const quota = await load('lib/native-quota.mjs')
  assert.equal(typeof quota.NativeQuotaAccounts, 'function')
})

test('browser dependency is not pulled in by normalization', () => {
  assert.ok(!read('lib/normalize.mjs').includes("from './browser.js'"))
  assert.ok(!readdirSync(join(here, 'lib')).includes('browser.mjs'), 'browser module must not be vendored')
})

test('normalizeConversation converts a simple conversation to markdown', async () => {
  const { normalizeConversation } = await load('lib/normalize.mjs')
  const conv = {
    title: '测试会话',
    conversation_id: '00000000-0000-4000-8000-000000000001',
    create_time: 1700000000,
    update_time: 1700000100,
    current_node: 'b',
    mapping: {
      a: { parent: null, message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['你好'] } } },
      b: { parent: 'a', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['你好，有什么可以帮你？'] } } },
    },
  }
  const md = normalizeConversation(conv, { root: here })
  assert.match(md, /^# 测试会话/)
  assert.match(md, /## 我/)
  assert.match(md, /你好/)
  assert.match(md, /## ChatGPT/)
  assert.match(md, /有什么可以帮你/)
})

test('vendored credential modules keep private file permissions', () => {
  assert.match(read('lib/storage.mjs'), /0o600|0600/, 'storage module must write private files')
})
