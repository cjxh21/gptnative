/**
 * login.mjs —— 通过 codex CLI 的 device-auth 登录，自动导入凭据到 ~/.gptaccounts。
 *
 * 目标：在新设备上只需 `gptnative login` 一条命令，用户点开链接输入验证码即可完成，
 * 凭据自动落到共享库的正确位置，无需手动找 auth.json。
 *
 * 实现要点：
 *   - 用 CODEX_HOME 指向临时目录，隔离 codex 的写入，不污染用户的 ~/.codex
 *   - 解析 device-auth 输出的验证码与链接，转发给用户
 *   - 登录完成后从临时目录读取 auth.json，校验身份后存入共享库
 *   - 临时目录用完即删
 *
 * 依赖：本机已安装 codex CLI（npm i -g @openai/codex 或 ChatGPT App 自带）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

import { accountsRoot, saveCredential, validateCredential } from './accounts-store.mjs'
import { loadValidatedConfig, saveConfig, defaultConfig, profileSettings } from './config.mjs'
import { configPath } from './accounts-store.mjs'

/** 常见 codex 可执行路径候选。 */
const CODEX_CANDIDATES = [
  'codex',
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
]

/** 去掉 ANSI 颜色/光标控制码；codex 输出带样式，不剥离会打断正则匹配。 */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}

/** 解析 device-auth 输出中的登录链接与一次性验证码。 */
export function parseDeviceAuthOutput(rawText) {
  const text = stripAnsi(rawText)
  const url = text.match(/https:\/\/auth\.openai\.com\/codex\/device/)
  // 验证码实测有两种形态：32X8-L0X0 与 32ZQ-19BI，段长不固定。
  // 匹配两段大写字母数字加连字符；用负向前瞻避免截断。
  const code = text.match(/([A-Z0-9]{3,8}-[A-Z0-9]{3,8})(?![A-Z0-9])/)
  return {
    verificationUrl: url ? url[0] : null,
    userCode: code ? code[1] : null,
  }
}

/**
 * 运行 codex login --device-auth，在隔离的 CODEX_HOME 中完成登录。
 *
 * onPrompt({verificationUrl, userCode}) 会在拿到验证码时被调用一次。
 * 超时或未登录成功则抛错。
 */
export function runDeviceLogin({ codexBin = 'codex', timeoutMs = 15 * 60 * 1000, onPrompt } = {}) {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), 'gptnative-login-'))
    const cleanup = () => { try { rmSync(home, { recursive: true, force: true }) } catch {} }
    let child
    let settled = false
    let buffer = ''
    let prompted = false

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child?.kill() } catch {}
      cleanup()
      fn(value)
    }

    const timer = setTimeout(() => {
      finish(reject, Object.assign(new Error('LOGIN_TIMEOUT'), { code: 'LOGIN_TIMEOUT', home }))
    }, timeoutMs)

    try {
      child = spawn(codexBin, ['login', '--device-auth'], {
        env: { ...process.env, CODEX_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish(reject, Object.assign(new Error('CODEX_NOT_FOUND'), { code: 'CODEX_NOT_FOUND', detail: String(error?.message ?? error) }))
      return
    }

    child.on('error', (error) => {
      finish(reject, Object.assign(new Error('CODEX_NOT_FOUND'), { code: 'CODEX_NOT_FOUND', detail: String(error?.message ?? error) }))
    })

    const onData = (chunk) => {
      buffer += chunk.toString()
      if (!prompted) {
        const parsed = parseDeviceAuthOutput(buffer)
        if (parsed.userCode) {
          prompted = true
          onPrompt?.(parsed)
        }
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    child.on('exit', (code) => {
      if (settled) return
      const authPath = join(home, 'auth.json')
      if (!existsSync(authPath)) {
        finish(reject, Object.assign(new Error('LOGIN_DID_NOT_COMPLETE'), {
          code: 'LOGIN_DID_NOT_COMPLETE',
          exitCode: code,
          detail: buffer.slice(-500),
        }))
        return
      }
      try {
        const auth = JSON.parse(readFileSync(authPath, 'utf8'))
        const check = validateCredential(auth, { requireFresh: false })
        if (!check.ok) {
          finish(reject, Object.assign(new Error('LOGIN_CREDENTIAL_INVALID'), { code: 'LOGIN_CREDENTIAL_INVALID', detail: check.code }))
          return
        }
        finish(resolve, { auth, info: check.info })
      } catch (error) {
        finish(reject, Object.assign(new Error('LOGIN_CREDENTIAL_UNREADABLE'), { code: 'LOGIN_CREDENTIAL_UNREADABLE', detail: String(error?.message ?? error) }))
      }
    })
  })
}

/**
 * 完整登录流程：登录 → 校验 → 存入共享库 → 按需写配置。
 *
 * 返回 {ok, email, profile, library, configPath, credentialPath}
 */
export async function loginAndImport({
  codexBin = 'codex',
  profileName = 'default',
  library = null,
  root = accountsRoot(),
  onPrompt,
  timeoutMs,
} = {}) {
  const { auth, info } = await runDeviceLogin({ codexBin, onPrompt, timeoutMs })

  const saved = saveCredential(info.email, auth, { root })

  // 配置：已有则新增/更新 profile，没有则创建
  const cfgPath = configPath(root)
  const loaded = loadValidatedConfig({ configFile: cfgPath })
  const targetLibrary = library ?? join(homedir(), 'Documents', 'ChatGPT', 'websync')
  let config
  if (loaded.ok) {
    config = loaded.config
    config.profiles = config.profiles ?? {}
    config.profiles[profileName] = {
      account: info.email,
      library: targetLibrary,
      embdDb: config.profiles[profileName]?.embdDb ?? 'chatgpt',
    }
  } else {
    config = defaultConfig({ email: info.email, library: targetLibrary })
    if (profileName !== 'default') {
      config.profiles = { [profileName]: config.profiles.default }
      config.activeProfile = profileName
    }
  }
  const savedConfig = saveConfig(config, { configFile: cfgPath })

  return {
    ok: true,
    email: info.email,
    profile: profileName,
    library: profileSettings(config, profileName).library,
    configPath: savedConfig.path,
    credentialPath: saved.path,
    info: { email: info.email, accountId: info.accountId, userId: info.userId, expiresAt: info.expiresAt },
  }
}
