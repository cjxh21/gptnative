import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const here = join(testDir, '..')
const load = (f) => import(pathToFileURL(join(here, f)).href)
const { parseDeviceAuthOutput, stripAnsi } = await load('lib/login.mjs')

test('stripAnsi removes color codes', () => {
  assert.equal(stripAnsi('\u001b[94mhello\u001b[0m'), 'hello')
  assert.equal(stripAnsi('plain'), 'plain')
})

test('parses device-auth prompt with ANSI styling (real codex output shape)', () => {
  // 这是 codex login --device-auth 的真实输出格式
  const raw = '\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n' +
    '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94m32X8-L0X0Z\u001b[0m\n'
  const parsed = parseDeviceAuthOutput(raw)
  assert.equal(parsed.verificationUrl, 'https://auth.openai.com/codex/device')
  assert.equal(parsed.userCode, '32X8-L0X0Z')
})

test('parses plain-text device-auth output', () => {
  const raw = 'Open https://auth.openai.com/codex/device and enter ABCD-1234'
  const parsed = parseDeviceAuthOutput(raw)
  assert.equal(parsed.verificationUrl, 'https://auth.openai.com/codex/device')
  assert.equal(parsed.userCode, 'ABCD-1234')
})

test('returns nulls for unrelated output', () => {
  const parsed = parseDeviceAuthOutput('Not logged in')
  assert.equal(parsed.verificationUrl, null)
  assert.equal(parsed.userCode, null)
})

test('does not mistake other hyphenated tokens for a code', () => {
  const parsed = parseDeviceAuthOutput('codex-cli 0.159.2 some-THING here')
  assert.equal(parsed.userCode, null, 'lowercase or wrong-length tokens must not match')
})
