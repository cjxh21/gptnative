import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const here = join(testDir, '..')
const load = (f) => import(pathToFileURL(join(here, f)).href)

const store = await load('lib/accounts-store.mjs')
const setup = await load('lib/setup.mjs')
const config = await load('lib/config.mjs')

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
const isolated = () => mkdtempSync(join(tmpdir(), 'gptnative-setup-'))

test('doctor reports not-configured on an empty store', () => {
  const root = isolated()
  try {
    const report = setup.runDoctor({ root })
    assert.equal(report.configured, false)
    const codes = report.issues.map(i => i.code).sort()
    assert.deepEqual(codes, ['CONFIG_MISSING', 'NO_CREDENTIALS'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('setup imports auth.json, then doctor reports configured', () => {
  const root = isolated()
  try {
    const authPath = join(root, 'incoming-auth.json')
    writeFileSync(authPath, JSON.stringify(makeAuth({ email: 'user@example.com', accountId: 'acc-x' })), { mode: 0o600 })
    const res = setup.runSetup({ authFile: authPath, library: join(root, 'lib'), root })
    assert.equal(res.ok, true)
    assert.equal(res.email, 'user@example.com')
    // 配置必须落在隔离 root 内，不能污染真实的 ~/.gptaccounts
    assert.equal(res.configPath, join(root, 'config.json'))
    assert.equal(statSync(res.credentialPath).mode & 0o777, 0o600)

    const report = setup.runDoctor({ root })
    assert.equal(report.configured, true, 'issues: ' + JSON.stringify(report.issues))
    assert.equal(report.accounts.length, 1)
    assert.equal(report.accounts[0].email, 'user@example.com')
    assert.equal(report.activeProfile, 'default')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('setup refuses a missing or malformed auth file', () => {
  const root = isolated()
  try {
    assert.throws(() => setup.readAuthFile(join(root, 'nope.json')), /AUTH_FILE_NOT_FOUND/)
    const bad = join(root, 'bad.json')
    writeFileSync(bad, '{not json')
    assert.throws(() => setup.readAuthFile(bad), /AUTH_FILE_NOT_JSON/)
    const incomplete = join(root, 'incomplete.json')
    writeFileSync(incomplete, JSON.stringify({ auth_mode: 'chatgpt' }))
    assert.throws(() => setup.readAuthFile(incomplete), /TOKENS_MISSING/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('setup rejects an expired-only credential path with clear code', () => {
  const root = isolated()
  try {
    const authPath = join(root, 'keyless.json')
    const auth = makeAuth()
    auth.auth_mode = 'api_key'
    writeFileSync(authPath, JSON.stringify(auth))
    assert.throws(() => setup.readAuthFile(authPath), /UNSUPPORTED_AUTH_MODE/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('setup supports custom profile names without clobbering others', () => {
  const root = isolated()
  try {
    const mk = (email, acc) => {
      const p = join(root, email.replace(/[^a-z0-9]/gi, '_') + '.json')
      writeFileSync(p, JSON.stringify(makeAuth({ email, accountId: acc })))
      return p
    }
    setup.runSetup({ authFile: mk('one@example.com', 'acc-1'), library: join(root, 'lib1'), root, profileName: 'one' })
    setup.runSetup({ authFile: mk('two@example.com', 'acc-2'), library: join(root, 'lib2'), root, profileName: 'two' })
    const loaded = config.loadValidatedConfig({ configFile: join(root, 'config.json') })
    assert.equal(loaded.ok, true)
    assert.deepEqual(Object.keys(loaded.config.profiles).sort(), ['one', 'two'])
    assert.equal(loaded.config.profiles.one.account, 'one@example.com')
    assert.equal(loaded.config.profiles.two.account, 'two@example.com')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor flags a profile whose credential is missing', () => {
  const root = isolated()
  try {
    const authPath = join(root, 'a.json')
    writeFileSync(authPath, JSON.stringify(makeAuth({ email: 'a@example.com' })))
    setup.runSetup({ authFile: authPath, library: join(root, 'lib'), root })
    // 手动把配置指向一个不存在的账号
    const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
    cfg.profiles.ghost = { account: 'ghost@example.com', library: join(root, 'lib') }
    cfg.activeProfile = 'ghost'
    writeFileSync(join(root, 'config.json'), JSON.stringify(cfg))
    const report = setup.runDoctor({ root })
    assert.equal(report.configured, false)
    assert.ok(report.issues.some(i => i.code === 'PROFILE_CREDENTIAL_MISSING'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('setup is idempotent for the same credential', () => {
  const root = isolated()
  try {
    const authPath = join(root, 'a.json')
    writeFileSync(authPath, JSON.stringify(makeAuth({ email: 'a@example.com' })))
    const first = setup.runSetup({ authFile: authPath, library: join(root, 'lib'), root })
    const second = setup.runSetup({ authFile: authPath, library: join(root, 'lib'), root })
    assert.equal(second.email, first.email)
    const report = setup.runDoctor({ root })
    assert.equal(report.configured, true)
    assert.equal(report.accounts.length, 1, 'no duplicate account entries')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
