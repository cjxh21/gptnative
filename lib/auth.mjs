/**
 * auth.mjs —— 从 ~/.gptaccounts 读取凭据并校验身份。
 *
 * 替代原先依赖 Workbench 的 accounts/A.json + binding.json + quota-auth 三层结构：
 * 现在只需要一份 Codex 标准格式的 auth.json。
 *
 * 校验规则（与原实现同等严格，不做任何放宽）：
 *   - auth_mode 必须是 chatgpt
 *   - id_token 的 email 必须存在且 email_verified === true
 *   - access_token 内嵌的 chatgpt_account_id / chatgpt_user_id 必须存在
 *   - account_id 两处必须一致
 *   - 必须配置期望邮箱，凭据邮箱与之不符即拒绝，不回退其他账号
 */
import {
  accountsRoot,
  configPath,
  readCredential,
  readJsonFile,
  listAccounts,
  validateCredential,
} from './accounts-store.mjs'

/** 读取配置文件；不存在返回 null。 */
export function loadConfig(root = accountsRoot()) {
  return readJsonFile(configPath(root))
}

/**
 * 解析本次要使用的账号与凭据。
 * 优先级：显式 --profile > 配置 activeProfile > 库内单账号自动选择。
 */
export function resolveAccount({ profile = null, config = null, root = accountsRoot() } = {}) {
  const cfg = config ?? loadConfig(root)
  const profiles = cfg?.profiles ?? {}
  const selected = profile ?? cfg?.activeProfile ?? null

  if (!selected) {
    const all = listAccounts(root)
    if (all.length === 0) throw Object.assign(new Error('NOT_CONFIGURED'), { code: 'NOT_CONFIGURED' })
    if (all.length > 1) throw Object.assign(new Error('PROFILE_REQUIRED'), { code: 'PROFILE_REQUIRED', available: all.map(x => x.email) })
    const email = all[0].email
    return { email, credential: readCredential(email, root), profile: null, profileConfig: null }
  }

  const profileConfig = profiles[selected]
  if (!profileConfig) throw Object.assign(new Error('UNKNOWN_PROFILE'), { code: 'UNKNOWN_PROFILE', profile: selected })
  const email = profileConfig.account
  if (!email) throw Object.assign(new Error('PROFILE_ACCOUNT_MISSING'), { code: 'PROFILE_ACCOUNT_MISSING', profile: selected })
  const credential = readCredential(email, root)
  if (!credential) throw Object.assign(new Error('CREDENTIAL_NOT_FOUND'), { code: 'CREDENTIAL_NOT_FOUND', email, profile: selected })
  return { email, credential, profile: selected, profileConfig }
}

/**
 * 完整身份校验：结构 + 期望邮箱。
 * expectedEmail 为空表示不限制邮箱（仅用于显式 inspect 场景）。
 */
export function verifyCredential(credential, { expectedEmail = null, requireFresh = true } = {}) {
  const check = validateCredential(credential, { requireFresh })
  if (!check.ok) throw Object.assign(new Error(check.code), { code: check.code, detail: check.detail })
  const info = check.info
  if (expectedEmail && String(info.email).toLowerCase() !== String(expectedEmail).toLowerCase()) {
    throw Object.assign(new Error('SELECTED_ACCOUNT_MISMATCH'), {
      code: 'SELECTED_ACCOUNT_MISMATCH',
      expected: expectedEmail,
      actual: info.email,
    })
  }
  return info
}

/** 供 CLI 展示的身份摘要，绝不含 token 值。 */
export function identitySummary(info) {
  return { email: info.email, userId: info.userId, accountId: info.accountId, source: 'gptaccounts' }
}
