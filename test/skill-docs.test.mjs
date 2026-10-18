import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const here = join(testDir, '..')
const read = (f) => readFileSync(join(here, f), 'utf8')

test('skill gates on doctor and does not require reading CONFIG.md when configured', () => {
  const skill = read('skills/gptweb/SKILL.md')
  assert.match(skill, /acw doctor/, 'skill must start with doctor self-check')
  assert.match(skill, /configured/, 'skill must branch on configured flag')
  assert.match(skill, /CONFIG\.md/, 'skill must point to CONFIG.md when unconfigured')
  // 已配置分支不应要求读 CONFIG.md
  const configuredBranch = skill.split('configured')[1] ?? ''
  assert.ok(!/直接按下面/.test(configuredBranch) || !/CONFIG\.md/.test(configuredBranch), 'configured path must not require CONFIG.md')
})

test('skill does not hardcode any specific account email', () => {
  const skill = read('skills/gptweb/SKILL.md')
  // 匹配任意真实邮箱形态，确保 skill 不绑定某个具体账号
  const emails = skill.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) ?? []
  assert.equal(emails.length, 0, 'skill must not pin a specific account: ' + emails.join(','))
})

test('skill states macOS-only platform boundary', () => {
  const skill = read('skills/gptweb/SKILL.md')
  assert.match(skill, /macOS/)
  assert.match(skill, /Windows|Linux/, 'must state other platforms are unsupported')
})

test('CONFIG.md documents setup, library change and multi-profile flows', () => {
  const doc = read('skills/gptweb/CONFIG.md')
  assert.match(doc, /acw setup --auth/)
  assert.match(doc, /--library/, 'must document storage location change')
  assert.match(doc, /--profile/, 'must document multi-account flow')
  assert.match(doc, /codex login/, 'must explain where auth.json comes from')
})

test('CONFIG.md and SKILL.md exist together in the skill directory', () => {
  assert.ok(existsSync(join(here, 'skills/gptweb/SKILL.md')))
  assert.ok(existsSync(join(here, 'skills/gptweb/CONFIG.md')))
})
