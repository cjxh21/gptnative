/**
 * config.mjs —— ~/.gptaccounts/config.json 配置加载与多 profile 支持。
 *
 * 从一开始就按多账号/多库建模，避免后续重构：
 *
 * {
 *   "schema": "gptaccounts/v1",
 *   "activeProfile": "default",
 *   "profiles": {
 *     "default": {
 *       "account": "you@example.com",
 *       "library": "~/Documents/ChatGPT/websync",
 *       "embdDb": "chatgpt"
 *     }
 *   }
 * }
 *
 * 每个 profile 拥有独立的账号与存储库，切换 profile 即切换账号和库。
 * 查找顺序：--config 显式指定 > GPTACCOUNTS_HOME 环境变量 > ~/.gptaccounts
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { accountsRoot, configPath, readJsonFile, writePrivate } from './accounts-store.mjs'

export const CONFIG_SCHEMA = 'gptaccounts/v1'

/** 展开 ~ 并为相对路径补全到 home。 */
export function expandPath(value) {
  if (typeof value !== 'string' || !value) return null
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return resolve(value)
}

export function configLocation({ configFile = null } = {}) {
  return configFile ? expandPath(configFile) : configPath(accountsRoot())
}

/** 默认配置：单账号单库。 */
export function defaultConfig({ email, library = join(homedir(), 'Documents/ChatGPT/websync') } = {}) {
  return {
    schema: CONFIG_SCHEMA,
    activeProfile: 'default',
    profiles: {
      default: { account: email ?? null, library, embdDb: 'chatgpt' },
    },
  }
}

/**
 * 校验配置结构与每个 profile 的必需字段。
 * 返回 {ok, code, detail}，不抛错。
 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object') return { ok: false, code: 'CONFIG_NOT_OBJECT' }
  if (config.schema !== CONFIG_SCHEMA) return { ok: false, code: 'CONFIG_SCHEMA_MISMATCH', detail: config.schema ?? null }
  const profiles = config.profiles
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return { ok: false, code: 'PROFILES_INVALID' }
  const names = Object.keys(profiles)
  if (names.length === 0) return { ok: false, code: 'PROFILES_EMPTY' }
  for (const name of names) {
    const p = profiles[name]
    if (!p || typeof p !== 'object') return { ok: false, code: 'PROFILE_INVALID', detail: name }
    if (!p.account) return { ok: false, code: 'PROFILE_ACCOUNT_MISSING', detail: name }
    if (!p.library) return { ok: false, code: 'PROFILE_LIBRARY_MISSING', detail: name }
  }
  if (config.activeProfile && !profiles[config.activeProfile]) {
    return { ok: false, code: 'ACTIVE_PROFILE_UNKNOWN', detail: config.activeProfile }
  }
  return { ok: true, code: 'OK' }
}

/**
 * 加载并校验配置。文件不存在返回 {ok:false, code:'NOT_CONFIGURED'}。
 */
export function loadValidatedConfig({ configFile = null } = {}) {
  const path = configLocation({ configFile })
  if (!existsSync(path)) return { ok: false, code: 'NOT_CONFIGURED', path }
  const config = readJsonFile(path)
  if (!config) return { ok: false, code: 'CONFIG_UNREADABLE', path }
  const check = validateConfig(config)
  return { ...check, path, config }
}

/** 原子写入配置（0600）。 */
export function saveConfig(config, { configFile = null } = {}) {
  const check = validateConfig(config)
  if (!check.ok) throw Object.assign(new Error(check.code), { code: check.code, detail: check.detail })
  const path = configLocation({ configFile })
  writePrivate(path, config)
  return { ok: true, path }
}

/**
 * 解析某个 profile 的有效设置（路径已展开为绝对路径）。
 * 这是 CLI 获取"用哪个库"的唯一入口。
 */
export function profileSettings(config, profileName = null) {
  const name = profileName ?? config?.activeProfile
  const profile = config?.profiles?.[name]
  if (!profile) throw Object.assign(new Error('UNKNOWN_PROFILE'), { code: 'UNKNOWN_PROFILE', profile: name })
  return {
    profile: name,
    account: profile.account,
    library: expandPath(profile.library),
    embdDb: profile.embdDb ?? 'chatgpt',
  }
}

/**
 * 列出全部 profile 摘要，供 CLI 展示。
 */
export function listProfiles(config) {
  if (!config?.profiles) return []
  return Object.entries(config.profiles).map(([name, p]) => ({
    name,
    account: p.account ?? null,
    library: expandPath(p.library),
    embdDb: p.embdDb ?? 'chatgpt',
    active: name === config.activeProfile,
  }))
}
