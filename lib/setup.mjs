/**
 * setup.mjs —— 首次配置与自检。
 *
 * setup：导入 auth.json → 校验身份 → 落库 → 写配置
 * doctor：返回 configured 状态，供 agent/skill 自检（无需读 CONFIG.md）
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import {
  accountsRoot,
  credentialsDir,
  configPath,
  describeCredential,
  listAccounts,
  readCredential,
  saveCredential,
  validateCredential,
} from './accounts-store.mjs'
import { CONFIG_SCHEMA, defaultConfig, loadValidatedConfig, saveConfig, profileSettings } from './config.mjs'

/** 读取并校验用户的 auth.json 文件。 */
export function readAuthFile(path) {
  if (!existsSync(path)) throw Object.assign(new Error('AUTH_FILE_NOT_FOUND'), { code: 'AUTH_FILE_NOT_FOUND', path })
  let parsed
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch {
    throw Object.assign(new Error('AUTH_FILE_NOT_JSON'), { code: 'AUTH_FILE_NOT_JSON', path })
  }
  const check = validateCredential(parsed, { requireFresh: false })
  if (!check.ok) {
    throw Object.assign(new Error(check.code), { code: check.code, detail: check.detail, path })
  }
  return { auth: parsed, info: check.info }
}

/**
 * 执行首次配置。
 *
 * options: { authFile, library, profileName='default', root, configFile, force }
 * 返回 {ok, email, profile, library, configPath, credentialPath, info}
 */
export function runSetup({
  authFile,
  library = null,
  profileName = 'default',
  root = accountsRoot(),
  configFile = null,
  force = false,
} = {}) {
  if (!authFile) throw Object.assign(new Error('AUTH_FILE_REQUIRED'), { code: 'AUTH_FILE_REQUIRED' })

  const { auth, info } = readAuthFile(authFile)
  const email = info.email

  // 已存在同一账号凭据且未加 --force 时，不静默覆盖
  const existing = readCredential(email, root)
  if (existing && !force) {
    const existingInfo = describeCredential(existing)
    if (existingInfo.accountId !== info.accountId) {
      throw Object.assign(new Error('CREDENTIAL_EXISTS_DIFFERENT_ACCOUNT'), {
        code: 'CREDENTIAL_EXISTS_DIFFERENT_ACCOUNT',
        email,
        existingAccountId: existingInfo.accountId,
        importedAccountId: info.accountId,
      })
    }
  }

  const saved = saveCredential(email, auth, { root })

  const targetLibrary = library ?? join(homedir(), 'Documents', 'ChatGPT', 'websync')
  // 配置路径必须跟随 root，否则测试或自定义库根会写进真实的 ~/.gptaccounts
  const effectiveConfigFile = configFile ?? configPath(root)
  let config
  const loaded = loadValidatedConfig({ configFile: effectiveConfigFile })
  if (loaded.ok && !force) {
    // 复用已有配置，仅新增/更新该 profile
    config = loaded.config
    config.profiles = config.profiles ?? {}
    config.profiles[profileName] = { account: email, library: targetLibrary, embdDb: config.profiles[profileName]?.embdDb ?? 'chatgpt' }
    config.activeProfile = config.activeProfile ?? profileName
  } else {
    config = defaultConfig({ email, library: targetLibrary })
    if (profileName !== 'default') {
      config.profiles = { [profileName]: config.profiles.default }
      config.activeProfile = profileName
    }
  }
  const savedConfig = saveConfig(config, { configFile: effectiveConfigFile })

  return {
    ok: true,
    email,
    profile: profileName,
    library: profileSettings(config, profileName).library,
    configPath: savedConfig.path,
    credentialPath: saved.path,
    info: { email: info.email, accountId: info.accountId, userId: info.userId, expiresAt: info.expiresAt },
  }
}

/**
 * 自检：agent 在调用前跑这个即可判断是否需要引导用户配置。
 *
 * 返回 {configured, issues[], accounts[], profiles[], activeProfile, root}
 * 只读，不产生任何写入。
 */
export function runDoctor({ root = accountsRoot(), configFile = null } = {}) {
  const issues = []
  const warnings = []
  const cfgPath = configFile ?? configPath(root)
  const accounts = listAccounts(root)
  const cfg = loadValidatedConfig({ configFile: cfgPath })

  if (!existsSync(cfgPath)) {
    issues.push({ code: 'CONFIG_MISSING', path: cfgPath })
  } else if (!cfg.ok) {
    issues.push({ code: cfg.code, detail: cfg.detail, path: cfgPath })
  }

  if (accounts.length === 0) {
    issues.push({ code: 'NO_CREDENTIALS', path: credentialsDir(root) })
  }

  for (const acct of accounts) {
    if (!acct.valid) issues.push({ code: 'CREDENTIAL_INVALID', email: acct.email, detail: acct.code })
    else if (acct.expired) issues.push({ code: 'ACCESS_TOKEN_EXPIRED', email: acct.email })
  }

  let activeProfile = null
  let library = null
  if (cfg.ok) {
    activeProfile = cfg.config.activeProfile ?? null
    try { library = profileSettings(cfg.config, activeProfile).library } catch (error) {
      issues.push({ code: error.code ?? 'PROFILE_INVALID', detail: error.message })
    }
    // 配置引用的账号必须有凭据
    for (const [name, p] of Object.entries(cfg.config.profiles ?? {})) {
      if (!readCredential(p.account, root)) {
        issues.push({ code: 'PROFILE_CREDENTIAL_MISSING', profile: name, account: p.account })
      }
    }
    // 库目录缺失不阻塞使用：首次 backup/ask 会自动创建。
    // 只在 warnings 里提示，不影响 configured 判定。
    if (library && !existsSync(library)) {
      warnings.push({ code: 'LIBRARY_NOT_CREATED_YET', path: library, detail: '首次写入时自动创建' })
    }
  }

  return {
    configured: issues.length === 0,
    root,
    accounts: accounts.map(a => ({ email: a.email, valid: a.valid, expired: a.expired, expiresInMs: a.expiresInMs })),
    activeProfile,
    library,
    profiles: cfg.ok ? Object.keys(cfg.config.profiles ?? {}) : [],
    issues,
    warnings,
  }
}

/** 供 CLI 打印的 setup 说明：缺失 auth.json 时该怎么办。 */
export function setupHelpText() {
  return [
    '需要一个 Codex 标准格式的 auth.json 才能开始。',
    '',
    '它通常来自以下任一位置（任选其一，复制路径即可）：',
    '  ~/.codex/auth.json                       Codex CLI 的登录凭据',
    '  ~/Library/Application Support/.../auth.json',
    '',
    '如果你从没登录过 Codex CLI，先在终端运行一次 codex login，',
    '登录后 auth.json 会自动出现在 ~/.codex/ 下。',
    '',
    '用法：acw setup --auth ~/.codex/auth.json --library ~/Documents/ChatGPT/websync',
  ].join('\n')
}
