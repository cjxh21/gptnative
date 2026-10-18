/**
 * accounts-store.mjs —— ~/.gptaccounts 共享凭据库。
 *
 * 与项目目录完全隔离，供本项目与其他 Codex 系工具共用同一份凭据。
 *
 * 目录布局：
 *   ~/.gptaccounts/
 *   ├── config.json                 全局配置（0600）
 *   ├── credentials/<email>.json    Codex 标准格式凭据（0600）
 *   └── credentials/.bak/           刷新前的备份
 *
 * 凭据格式采用 **Codex 标准格式**，与 ~/.codex/auth.json 完全一致：
 *   { OPENAI_API_KEY, auth_mode, last_refresh, tokens: {
 *       access_token, refresh_token, id_token, account_id } }
 * 这样其他 Codex 系工具可以直接读取本目录，无需转换。
 *
 * 安全约束：只读写 ~/.gptaccounts，绝不修改 ~/.codex 或 CC Switch。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const GPTACCOUNTS_SCHEMA = 'gptaccounts/v1'
export const CREDENTIAL_FILE_MODE = 0o600
export const DIRECTORY_MODE = 0o700

/** 共享库根目录；可用 GPTACCOUNTS_HOME 覆盖（测试用）。 */
export function accountsRoot() {
  return process.env.GPTACCOUNTS_HOME || join(homedir(), '.gptaccounts')
}
export const credentialsDir = (root = accountsRoot()) => join(root, 'credentials')
export const configPath = (root = accountsRoot()) => join(root, 'config.json')

/** 邮箱归一化为可安全作文件名的形式，同时保持可读。 */
export function emailKey(email) {
  const value = String(email ?? '').trim().toLowerCase()
  if (!value) throw new Error('EMAIL_REQUIRED')
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(value)) throw new Error('EMAIL_INVALID')
  if (value.includes('/') || value.includes('\\') || value.includes('..')) throw new Error('EMAIL_UNSAFE')
  return value
}
export const credentialPath = (email, root = accountsRoot()) => join(credentialsDir(root), emailKey(email) + '.json')

function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE })
  return path
}

/** 原子写入 0600 文件。 */
export function writePrivate(path, value) {
  privateDir(dirname(path))
  const temp = path + '.' + randomUUID() + '.tmp'
  writeFileSync(temp, JSON.stringify(value, null, 1) + '\n', { flag: 'wx', mode: CREDENTIAL_FILE_MODE })
  renameSync(temp, path)
}

export function readJsonFile(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

/** 解码 JWT 载荷；失败返回 null（不抛错，便于校验分支处理）。 */
export function decodeJwt(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return null
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  } catch { return null }
}

/** timestamp 秒 → 毫秒；兼容秒/毫秒两种输入。 */
function toMillis(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1e12 ? n : Math.round(n * 1000)
}

/**
 * 从 Codex 标准格式凭据中提取可校验的身份与时效信息。
 * 这是唯一解析凭据语义的函数，其他模块只消费它的输出。
 */
export function describeCredential(auth) {
  const tokens = auth?.tokens ?? {}
  const idClaims = decodeJwt(tokens.id_token)
  const accessClaims = decodeJwt(tokens.access_token)
  const namespace = accessClaims?.['https://api.openai.com/auth'] ?? {}
  const expiresAt = toMillis(accessClaims?.exp)
  return {
    email: idClaims?.email ?? null,
    emailVerified: idClaims?.email_verified === true,
    userId: namespace.chatgpt_user_id ?? null,
    accountId: namespace.chatgpt_account_id ?? null,
    tokenAccountId: tokens.account_id ?? null,
    expiresAt: expiresAt || null,
    expiresInMs: expiresAt ? expiresAt - Date.now() : null,
    expired: expiresAt ? expiresAt <= Date.now() : true,
    hasAccessToken: typeof tokens.access_token === 'string' && tokens.access_token.length > 0,
    hasRefreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0,
    authMode: auth?.auth_mode ?? null,
  }
}

/**
 * 校验一份凭据是否可用。
 * 返回 {ok, code, detail} —— 不抛错，让调用方决定如何报告。
 */
export function validateCredential(auth, { requireFresh = false, now = Date.now() } = {}) {
  if (!auth || typeof auth !== 'object') return { ok: false, code: 'CREDENTIAL_NOT_OBJECT' }
  const tokens = auth.tokens
  if (!tokens || typeof tokens !== 'object') return { ok: false, code: 'TOKENS_MISSING' }
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) return { ok: false, code: 'ACCESS_TOKEN_MISSING' }
  if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) return { ok: false, code: 'REFRESH_TOKEN_MISSING' }
  if (auth.auth_mode !== 'chatgpt') return { ok: false, code: 'UNSUPPORTED_AUTH_MODE', detail: auth.auth_mode ?? null }
  const info = describeCredential(auth)
  const idClaims = decodeJwt(tokens.id_token)
  if (!idClaims) return { ok: false, code: 'ID_TOKEN_UNREADABLE' }
  if (!info.email) return { ok: false, code: 'EMAIL_MISSING' }
  if (info.emailVerified !== true) return { ok: false, code: 'EMAIL_NOT_VERIFIED' }
  if (!info.accountId) return { ok: false, code: 'ACCOUNT_ID_MISSING' }
  if (!info.userId) return { ok: false, code: 'USER_ID_MISSING' }
  if (String(info.accountId) !== String(info.tokenAccountId ?? info.accountId)) {
    return { ok: false, code: 'PRINCIPAL_MISMATCH' }
  }
  const expiresAt = info.expiresAt
  if (!expiresAt) return { ok: false, code: 'EXPIRY_UNREADABLE' }
  if (requireFresh && expiresAt <= now + 30_000) return { ok: false, code: 'ACCESS_TOKEN_EXPIRED' }
  return { ok: true, code: 'OK', info }
}

/** 列出库中全部凭据及其状态（不返回任何 token 值）。 */
export function listAccounts(root = accountsRoot()) {
  const dir = credentialsDir(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const path = join(dir, f)
      const auth = readJsonFile(path)
      const info = auth ? describeCredential(auth) : null
      const check = auth ? validateCredential(auth) : { ok: false, code: 'UNREADABLE' }
      return {
        email: info?.email ?? f.replace(/\.json$/, ''),
        accountId: info?.accountId ?? null,
        userId: info?.userId ?? null,
        expiresAt: info?.expiresAt ?? null,
        expiresInMs: info?.expiresInMs ?? null,
        expired: info?.expired ?? true,
        hasRefreshToken: info?.hasRefreshToken ?? false,
        valid: check.ok,
        code: check.code,
        path,
      }
    })
    .filter(Boolean)
}

/** 读取单个账号凭据；不存在返回 null。 */
export function readCredential(email, root = accountsRoot()) {
  return readJsonFile(credentialPath(email, root))
}

/**
 * 写入账号凭据。写前把旧文件备份到 credentials/.bak/，保留最近一份。
 * 同时校验：邮箱与凭据内身份必须一致，防止写错槽位。
 */
export function saveCredential(email, auth, { root = accountsRoot(), backup = true } = {}) {
  const key = emailKey(email)
  const check = validateCredential(auth, { requireFresh: false })
  if (!check.ok) throw Object.assign(new Error(check.code), { code: check.code })
  if (String(check.info.email).toLowerCase() !== key) {
    throw Object.assign(new Error('CREDENTIAL_EMAIL_MISMATCH'), { code: 'CREDENTIAL_EMAIL_MISMATCH' })
  }
  const path = credentialPath(key, root)
  if (backup && existsSync(path)) {
    const bakDir = privateDir(join(credentialsDir(root), '.bak'))
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(path, join(bakDir, key + '.' + stamp + '.json'))
  }
  writePrivate(path, auth)
  return { ok: true, path }
}

/** 删除账号凭据（仅删本库文件）。 */
export function removeCredential(email, root = accountsRoot()) {
  const path = credentialPath(email, root)
  if (!existsSync(path)) return { ok: true, removed: false }
  rmSync(path)
  return { ok: true, removed: true }
}
