/**
 * token-refresh.mjs —— access_token 自动刷新。
 *
 * 方案 B：临近过期时自动用 refresh_token 换新 token，并整体写回 ~/.gptaccounts。
 *
 * 安全边界（不可放宽）：
 *   - 只写 ~/.gptaccounts/credentials/<email>.json，绝不写 ~/.codex 或 CC Switch
 *   - 写回前由 accounts-store 自动备份到 credentials/.bak/
 *   - 刷新失败保留原凭据不清空，返回明确错误码
 *   - 刷新后必须校验新凭据身份与旧凭据一致，防止串号
 *
 * 实测依据：refresh_token 可重复使用、不会一次性作废，故多工具共享同一
 * refresh_token 是安全的，不会互相踢下线（详见 verification 记录）。
 */
import { saveCredential, describeCredential, validateCredential, readCredential } from './accounts-store.mjs'

export const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token'
export const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
/** 剩余寿命低于该值时视为需要刷新。 */
export const REFRESH_THRESHOLD_MS = 5 * 60 * 1000

/** 判断凭据是否需要刷新。 */
export function needsRefresh(credential, { now = Date.now(), thresholdMs = REFRESH_THRESHOLD_MS } = {}) {
  const info = describeCredential(credential)
  if (!info.expiresAt) return true
  return info.expiresAt - now <= thresholdMs
}

/**
 * 调用 token 端点换取新凭据。
 * 返回新的 Codex 标准格式 auth 对象；失败抛出带 code 的错误。
 */
export async function exchangeRefreshToken(credential, { fetchImpl = globalThis.fetch, clientId = null } = {}) {
  const refreshToken = credential?.tokens?.refresh_token
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw Object.assign(new Error('REFRESH_TOKEN_MISSING'), { code: 'REFRESH_TOKEN_MISSING' })
  }
  const cid = clientId
    ?? describeCredential(credential).clientId
    ?? credential?.tokens?.client_id
    ?? DEFAULT_CLIENT_ID

  const body = {
    client_id: cid,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'openid profile email offline_access',
  }

  let response
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw Object.assign(new Error('REFRESH_NETWORK_FAILED'), { code: 'REFRESH_NETWORK_FAILED', detail: String(error?.message ?? error) })
  }

  if (!response.ok) {
    throw Object.assign(new Error('REFRESH_HTTP_ERROR'), { code: 'REFRESH_HTTP_ERROR', status: response.status })
  }

  let data
  try { data = await response.json() } catch {
    throw Object.assign(new Error('REFRESH_BAD_JSON'), { code: 'REFRESH_BAD_JSON' })
  }
  if (typeof data?.access_token !== 'string' || !data.access_token) {
    throw Object.assign(new Error('REFRESH_NO_ACCESS_TOKEN'), { code: 'REFRESH_NO_ACCESS_TOKEN' })
  }

  // 组装为 Codex 标准格式，保持与其他工具兼容
  return {
    OPENAI_API_KEY: credential?.OPENAI_API_KEY ?? null,
    auth_mode: 'chatgpt',
    last_refresh: new Date().toISOString(),
    tokens: {
      access_token: data.access_token,
      // 服务端可能轮换 refresh_token；未返回时保留旧的
      refresh_token: data.refresh_token ?? refreshToken,
      id_token: data.id_token ?? credential?.tokens?.id_token ?? null,
      account_id: credential?.tokens?.account_id ?? null,
    },
  }
}

/**
 * 确保凭据可用：必要时刷新并写回。
 *
 * 返回 {credential, refreshed, info}。
 * 刷新后身份不一致会拒绝写回，保护原凭据。
 */
export async function ensureFreshCredential(email, credential, {
  root,
  now = Date.now(),
  thresholdMs = REFRESH_THRESHOLD_MS,
  fetchImpl = globalThis.fetch,
  force = false,
} = {}) {
  const before = describeCredential(credential)
  if (!force && !needsRefresh(credential, { now, thresholdMs })) {
    return { credential, refreshed: false, info: before }
  }

  const next = await exchangeRefreshToken(credential, { fetchImpl })
  // 新凭据补全 account_id（服务端不返回时沿用旧的）
  if (!next.tokens.account_id) next.tokens.account_id = before.accountId

  // 防串号必须早于结构校验：account_id 与 token_account_id 的自洽性检查
  // 会先撞上 PRINCIPAL_MISMATCH，掩盖"账号已变"这个更重要的结论。
  const after = describeCredential(next)
  if (before.accountId && after.accountId && String(before.accountId) !== String(after.accountId)) {
    throw Object.assign(new Error('REFRESH_PRINCIPAL_CHANGED'), {
      code: 'REFRESH_PRINCIPAL_CHANGED',
      before: before.accountId,
      after: after.accountId,
    })
  }
  if (before.email && after.email && String(after.email).toLowerCase() !== String(before.email).toLowerCase()) {
    throw Object.assign(new Error('REFRESH_EMAIL_CHANGED'), {
      code: 'REFRESH_EMAIL_CHANGED',
      before: before.email,
      after: after.email,
    })
  }

  const check = validateCredential(next, { requireFresh: true })
  if (!check.ok) {
    throw Object.assign(new Error('REFRESHED_CREDENTIAL_INVALID'), {
      code: 'REFRESHED_CREDENTIAL_INVALID',
      detail: check.code,
    })
  }

  const saved = saveCredential(email, next, { root })
  return { credential: next, refreshed: true, info: check.info, path: saved.path }
}
