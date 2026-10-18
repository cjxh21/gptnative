import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const here = join(testDir, '..')
const load = (f) => import(pathToFileURL(join(here, f)).href)

const store = await load('lib/accounts-store.mjs')

/** 构造一份结构合法的 Codex 标准凭据（假的 JWT，只用于结构测试）。 */
function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return [b64({ alg: 'none' }), b64(payload), 'sig'].join('.')
}
function makeAuth({ email = 'test@example.com', expInMs = 3600_000, accountId = 'acc-1', userId = 'user-1' } = {}) {
  const exp = Math.floor((Date.now() + expInMs) / 1000)
  return {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    last_refresh: new Date().toISOString(),
    tokens: {
      access_token: fakeJwt({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_user_id: userId } }),
      refresh_token: 'refresh-' + accountId,
      id_token: fakeJwt({ email, email_verified: true }),
      account_id: accountId,
    },
  }
}

const isolated = () => mkdtempSync(join(tmpdir(), 'gptaccounts-test-'))

test('emailKey normalizes and rejects unsafe values', () => {
  assert.equal(store.emailKey('  Alice.Smith@Example.COM '), 'alice.smith@example.com')
  assert.throws(() => store.emailKey(''), /EMAIL_REQUIRED/)
  assert.throws(() => store.emailKey('not-an-email'), /EMAIL_INVALID/)
  assert.throws(() => store.emailKey('a/../b@x.com'), /EMAIL_UNSAFE|EMAIL_INVALID/)
})

test('saveCredential writes Codex-standard format with 0600 and 0700 dir', () => {
  const root = isolated()
  try {
    const auth = makeAuth()
    const res = store.saveCredential('test@example.com', auth, { root })
    assert.ok(res.ok)
    const path = res.path
    assert.equal(statSync(path).mode & 0o777, 0o600, 'credential file must be 0600')
    assert.equal(statSync(join(root, 'credentials')).mode & 0o777, 0o700, 'credentials dir must be 0700')
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    // 必须保持 Codex 标准格式，其他 codex 工具才能直接读
    assert.deepEqual(Object.keys(saved).sort(), ['OPENAI_API_KEY', 'auth_mode', 'last_refresh', 'tokens'])
    assert.deepEqual(Object.keys(saved.tokens).sort(), ['access_token', 'account_id', 'id_token', 'refresh_token'])
    assert.equal(saved.auth_mode, 'chatgpt')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('saveCredential keeps a backup of the previous credential', () => {
  const root = isolated()
  try {
    store.saveCredential('test@example.com', makeAuth({ accountId: 'acc-1' }), { root })
    store.saveCredential('test@example.com', makeAuth({ accountId: 'acc-2' }), { root })
    const bakDir = join(root, 'credentials', '.bak')
    const baks = readdirSync(bakDir).filter(f => f.endsWith('.json'))
    assert.equal(baks.length, 1, 'exactly one backup after one overwrite')
    const bak = JSON.parse(readFileSync(join(bakDir, baks[0]), 'utf8'))
    assert.equal(bak.tokens.account_id, 'acc-1', 'backup holds the replaced credential')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('saveCredential refuses to write a credential into the wrong email slot', () => {
  const root = isolated()
  try {
    const auth = makeAuth({ email: 'real@example.com' })
    assert.throws(() => store.saveCredential('other@example.com', auth, { root }), /CREDENTIAL_EMAIL_MISMATCH/)
    assert.ok(!existsSync(store.credentialPath('other@example.com', root)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('validateCredential detects expired and malformed credentials', () => {
  const good = store.validateCredential(makeAuth())
  assert.equal(good.ok, true)
  assert.equal(good.info.email, 'test@example.com')

  const expired = store.validateCredential(makeAuth({ expInMs: -60_000 }), { requireFresh: true })
  assert.equal(expired.ok, false)
  assert.equal(expired.code, 'ACCESS_TOKEN_EXPIRED')

  assert.equal(store.validateCredential(null).ok, false)
  assert.equal(store.validateCredential({}).code, 'TOKENS_MISSING')
  const noRef = makeAuth(); delete noRef.tokens.refresh_token
  assert.equal(store.validateCredential(noRef).code, 'REFRESH_TOKEN_MISSING')
  const wrongMode = makeAuth(); wrongMode.auth_mode = 'api_key'
  assert.equal(store.validateCredential(wrongMode).code, 'UNSUPPORTED_AUTH_MODE')
  const unverified = (() => {
    const a = makeAuth()
    a.tokens.id_token = fakeJwt({ email: 'test@example.com', email_verified: false })
    return a
  })()
  assert.equal(store.validateCredential(unverified).code, 'EMAIL_NOT_VERIFIED')
})

test('listAccounts reports status without leaking token values', () => {
  const root = isolated()
  try {
    store.saveCredential('a@example.com', makeAuth({ email: 'a@example.com', accountId: 'acc-a' }), { root })
    store.saveCredential('b@example.com', makeAuth({ email: 'b@example.com', accountId: 'acc-b', expInMs: -1000 }), { root })
    const list = store.listAccounts(root)
    assert.equal(list.length, 2)
    const a = list.find(x => x.email === 'a@example.com')
    assert.equal(a.valid, true)
    assert.equal(a.expired, false)
    const b = list.find(x => x.email === 'b@example.com')
    assert.equal(b.expired, true)
    const serialized = JSON.stringify(list)
    assert.ok(!serialized.includes('refresh-acc'), 'must not expose refresh tokens')
    assert.ok(!serialized.includes('eyJ'), 'must not expose raw JWT values')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('store never writes outside its own root', () => {
  const root = isolated()
  try {
    store.saveCredential('test@example.com', makeAuth(), { root })
    const entries = readdirSync(root)
    assert.deepEqual(entries.sort(), ['credentials'])
    // 凭据不得出现在项目目录
    assert.ok(!existsSync(join(here, 'credentials')), 'project dir must stay free of credentials')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
