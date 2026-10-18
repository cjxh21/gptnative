import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const here = join(testDir, '..')
const cli = join(here, 'native-cli.mjs')

function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return [b64({ alg: 'none' }), b64(payload), 'sig'].join('.')
}
function makeAuth({ email = 'cli@example.com', accountId = 'acc-cli' } = {}) {
  const exp = Math.floor((Date.now() + 3600_000) / 1000)
  return {
    OPENAI_API_KEY: null, auth_mode: 'chatgpt', last_refresh: new Date().toISOString(),
    tokens: {
      access_token: fakeJwt({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_user_id: 'user-cli' } }),
      refresh_token: 'rt-cli',
      id_token: fakeJwt({ email, email_verified: true }),
      account_id: accountId,
    },
  }
}
/** 在隔离的 GPTACCOUNTS_HOME 下运行 CLI。 */
function run(args, { root }) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GPTACCOUNTS_HOME: root },
  })
}
const isolated = () => mkdtempSync(join(tmpdir(), 'gptnative-cli-'))

test('doctor exits 2 and reports configured:false before setup', () => {
  const root = isolated()
  try {
    const res = run(['doctor'], { root })
    assert.equal(res.status, 2, 'unconfigured doctor should use exit code 2')
    const report = JSON.parse(res.stdout)
    assert.equal(report.configured, false)
    assert.ok(report.issues.some(i => i.code === 'CONFIG_MISSING'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('setup then doctor exits 0 and reports configured:true', () => {
  const root = isolated()
  try {
    const authPath = join(root, 'auth.json')
    writeFileSync(authPath, JSON.stringify(makeAuth()), { mode: 0o600 })
    const setup = run(['setup', '--auth', authPath, '--library', join(root, 'lib')], { root })
    assert.equal(setup.status, 0, setup.stderr)
    const setupOut = JSON.parse(setup.stdout)
    assert.equal(setupOut.ok, true)
    assert.equal(setupOut.email, 'cli@example.com')

    const doctor = run(['doctor'], { root })
    assert.equal(doctor.status, 0)
    assert.equal(JSON.parse(doctor.stdout).configured, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('setup without --auth prints guidance and fails cleanly', () => {
  const root = isolated()
  try {
    const res = run(['setup'], { root })
    assert.notEqual(res.status, 0)
    // 失败信息走 stderr：第一行是 JSON，其后是引导文案
    const firstLine = res.stderr.split('\n')[0]
    const report = JSON.parse(firstLine)
    assert.equal(report.code, 'AUTH_FILE_REQUIRED')
    assert.match(res.stderr, /auth\.json/, 'should explain where auth.json comes from')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('profiles lists configured profiles', () => {
  const root = isolated()
  try {
    const authPath = join(root, 'auth.json')
    writeFileSync(authPath, JSON.stringify(makeAuth()), { mode: 0o600 })
    run(['setup', '--auth', authPath, '--library', join(root, 'lib')], { root })
    const res = run(['profiles'], { root })
    assert.equal(res.status, 0, res.stderr)
    const out = JSON.parse(res.stdout)
    assert.equal(out.ok, true)
    assert.equal(out.activeProfile, 'default')
    assert.equal(out.profiles.length, 1)
    assert.equal(out.profiles[0].account, 'cli@example.com')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('CLI does not write into the real home when GPTACCOUNTS_HOME is set', () => {
  const root = isolated()
  try {
    const authPath = join(root, 'auth.json')
    writeFileSync(authPath, JSON.stringify(makeAuth()), { mode: 0o600 })
    const setup = run(['setup', '--auth', authPath, '--library', join(root, 'lib')], { root })
    assert.equal(JSON.parse(setup.stdout).configPath, join(root, 'config.json'), 'config must stay inside the isolated root')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
