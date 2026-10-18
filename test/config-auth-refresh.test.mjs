import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const here = join(testDir, '..')
const load = (f) => import(pathToFileURL(join(here, f)).href)

const store = await load('lib/accounts-store.mjs')
const config = await load('lib/config.mjs')
const auth = await load('lib/auth.mjs')
const refresh = await load('lib/token-refresh.mjs')

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
const isolated = () => mkdtempSync(join(tmpdir(), 'acw-cfg-'))

/* ---------------- config ---------------- */

test('config: defaultConfig is valid and round-trips', () => {
  const root = isolated()
  try {
    const cfg = config.defaultConfig({ email: 'a@example.com', library: `~/Documents/ChatGPT/websync` })
    assert.equal(config.validateConfig(cfg).ok, true)
    const saved = config.saveConfig(cfg, { configFile: join(root, 'config.json') })
    assert.equal(statSync(saved.path).mode & 0o777, 0o600)
    const loaded = config.loadValidatedConfig({ configFile: join(root, 'config.json') })
    assert.equal(loaded.ok, true)
    assert.equal(loaded.config.activeProfile, 'default')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('config: rejects malformed shapes', () => {
  assert.equal(config.validateConfig(null).code, 'CONFIG_NOT_OBJECT')
  assert.equal(config.validateConfig({}).code, 'CONFIG_SCHEMA_MISMATCH')
  assert.equal(config.validateConfig({ schema: config.CONFIG_SCHEMA, profiles: {} }).code, 'PROFILES_EMPTY')
  assert.equal(config.validateConfig({ schema: config.CONFIG_SCHEMA, profiles: { d: { account: 'a@b.com' } } }).code, 'PROFILE_LIBRARY_MISSING')
  assert.equal(config.validateConfig({ schema: config.CONFIG_SCHEMA, activeProfile: 'x', profiles: { d: { account: 'a@b.com', library: '/l' } } }).code, 'ACTIVE_PROFILE_UNKNOWN')
})

test('config: multiple profiles keep independent libraries', () => {
  const cfg = {
    schema: config.CONFIG_SCHEMA,
    activeProfile: 'work',
    profiles: {
      personal: { account: 'p@example.com', library: '/lib/personal', embdDb: 'chatgpt' },
      work: { account: 'w@example.com', library: '/lib/work', embdDb: 'chatgpt-work' },
    },
  }
  assert.equal(config.validateConfig(cfg).ok, true)
  assert.equal(config.profileSettings(cfg).library, '/lib/work')
  assert.equal(config.profileSettings(cfg, 'personal').library, '/lib/personal')
  const list = config.listProfiles(cfg)
  assert.equal(list.length, 2)
  assert.equal(list.find(p => p.name === 'work').active, true)
  assert.throws(() => config.profileSettings(cfg, 'nope'), /UNKNOWN_PROFILE/)
})

test('config: expandPath resolves home shorthand', () => {
  const os = { homedir: process.env.HOME }
  assert.equal(config.expandPath('~/Documents/x'), join(os.homedir, 'Documents/x'))
  assert.equal(config.expandPath('/absolute/path'), '/absolute/path')
  assert.equal(config.expandPath(null), null)
})

/* ---------------- auth ---------------- */

test('auth: resolveAccount picks single account when no config exists', () => {
  const root = isolated()
  try {
    store.saveCredential('only@example.com', makeAuth({ email: 'only@example.com', accountId: 'acc-only' }), { root })
    const resolved = auth.resolveAccount({ root })
    assert.equal(resolved.email, 'only@example.com')
    assert.equal(resolved.profile, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('auth: resolveAccount errors clearly when not configured', () => {
  const root = isolated()
  try {
    assert.throws(() => auth.resolveAccount({ root }), /NOT_CONFIGURED/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('auth: resolveAccount requires profile when multiple accounts exist', () => {
  const root = isolated()
  try {
    store.saveCredential('a@example.com', makeAuth({ email: 'a@example.com', accountId: 'acc-a' }), { root })
    store.saveCredential('b@example.com', makeAuth({ email: 'b@example.com', accountId: 'acc-b' }), { root })
    assert.throws(() => auth.resolveAccount({ root }), /PROFILE_REQUIRED/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('auth: verifyCredential enforces expected email and rejects mismatch', () => {
  const cred = makeAuth({ email: 'real@example.com' })
  const info = auth.verifyCredential(cred, { expectedEmail: 'real@example.com' })
  assert.equal(info.email, 'real@example.com')
  assert.throws(() => auth.verifyCredential(cred, { expectedEmail: 'other@example.com' }), /SELECTED_ACCOUNT_MISMATCH/)
})

test('auth: verifyCredential refuses expired credential when fresh required', () => {
  const cred = makeAuth({ expInMs: -60_000 })
  assert.throws(() => auth.verifyCredential(cred, { requireFresh: true }), /ACCESS_TOKEN_EXPIRED/)
  assert.ok(auth.verifyCredential(cred, { requireFresh: false }))
})

/* ---------------- token refresh ---------------- */

test('refresh: needsRefresh respects threshold', () => {
  assert.equal(refresh.needsRefresh(makeAuth({ expInMs: 60_000 })), true, '1 min left needs refresh')
  assert.equal(refresh.needsRefresh(makeAuth({ expInMs: 3600_000 })), false, '1 hour left is fine')
})

test('refresh: exchangeRefreshToken builds a codex-standard credential', async () => {
  const cred = makeAuth({ expInMs: 60_000, accountId: 'acc-1' })
  const fakeFetch = async (url, opts) => {
    assert.equal(url, refresh.TOKEN_ENDPOINT)
    const body = JSON.parse(opts.body)
    assert.equal(body.grant_type, 'refresh_token')
    assert.equal(body.refresh_token, 'refresh-acc-1')
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: fakeJwt({ exp: Math.floor((Date.now() + 3600_000) / 1000), 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1', chatgpt_user_id: 'user-1' } }),
        refresh_token: 'refresh-acc-1-rotated',
        id_token: fakeJwt({ email: 'test@example.com', email_verified: true }),
      }),
    }
  }
  const next = await refresh.exchangeRefreshToken(cred, { fetchImpl: fakeFetch })
  assert.deepEqual(Object.keys(next).sort(), ['OPENAI_API_KEY', 'auth_mode', 'last_refresh', 'tokens'])
  assert.equal(next.auth_mode, 'chatgpt')
  assert.equal(next.tokens.refresh_token, 'refresh-acc-1-rotated', 'rotated refresh token is kept')
})

test('refresh: ensureFreshCredential refreshes, writes back and keeps a backup', async () => {
  const root = isolated()
  try {
    const email = 'test@example.com'
    store.saveCredential(email, makeAuth({ expInMs: 60_000, accountId: 'acc-1' }), { root })
    const before = store.readCredential(email, root)
    const fakeFetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        access_token: fakeJwt({ exp: Math.floor((Date.now() + 3600_000) / 1000), 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1', chatgpt_user_id: 'user-1' } }),
        refresh_token: 'rotated-rt',
        id_token: fakeJwt({ email, email_verified: true }),
      }),
    })
    const res = await refresh.ensureFreshCredential(email, before, { root, fetchImpl: fakeFetch })
    assert.equal(res.refreshed, true)
    const after = store.readCredential(email, root)
    assert.notEqual(after.tokens.access_token, before.tokens.access_token, 'access token updated on disk')
    assert.equal(after.tokens.refresh_token, 'rotated-rt')
    assert.ok(existsSync(join(root, 'credentials', '.bak')), 'backup dir created')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('refresh: does not refresh when token is healthy', async () => {
  const root = isolated()
  try {
    const email = 'test@example.com'
    const cred = makeAuth({ expInMs: 3600_000 })
    const res = await refresh.ensureFreshCredential(email, cred, {
      root,
      fetchImpl: async () => { throw new Error('must not be called') },
    })
    assert.equal(res.refreshed, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('refresh: refuses to write back a credential for a different account', async () => {
  const root = isolated()
  try {
    const email = 'test@example.com'
    const cred = makeAuth({ expInMs: 60_000, accountId: 'acc-original' })
    store.saveCredential(email, cred, { root })
    const fakeFetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        access_token: fakeJwt({ exp: Math.floor((Date.now() + 3600_000) / 1000), 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-DIFFERENT', chatgpt_user_id: 'user-1' } }),
        refresh_token: 'x',
        id_token: fakeJwt({ email, email_verified: true }),
      }),
    })
    await assert.rejects(
      () => refresh.ensureFreshCredential(email, cred, { root, fetchImpl: fakeFetch }),
      /REFRESH_PRINCIPAL_CHANGED/
    )
    const after = store.readCredential(email, root)
    assert.equal(after.tokens.access_token, cred.tokens.access_token, 'original credential must be preserved on principal change')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('refresh: keeps original credential when refresh fails', async () => {
  const root = isolated()
  try {
    const email = 'test@example.com'
    const cred = makeAuth({ expInMs: 60_000 })
    store.saveCredential(email, cred, { root })
    const failing = async () => ({ ok: false, status: 401, json: async () => ({}) })
    await assert.rejects(() => refresh.ensureFreshCredential(email, cred, { root, fetchImpl: failing }), /REFRESH_HTTP_ERROR/)
    const after = store.readCredential(email, root)
    assert.equal(after.tokens.access_token, cred.tokens.access_token, 'credential preserved after failed refresh')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
