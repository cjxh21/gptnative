import { readJson, AccountStore } from './storage.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { accountToken } from './siwc.mjs';

export function parseQuota(data) {
  const windows = {};
  for (const value of [data?.rate_limit?.primary_window, data?.rate_limit?.secondary_window]) {
    if (!value || typeof value.used_percent !== 'number' || !Number.isFinite(value.used_percent)) continue;
    const key = ({ 18000: 'fiveHour', 604800: 'weekly' })[value.limit_window_seconds];
    if (!key) continue;
    const reset = Number(value.reset_at);
    windows[key] = { percent: Math.max(0, Math.min(100, value.used_percent)),
      resetsAt: Number.isFinite(reset) && reset > 0 && reset < 8640000000000 ? new Date(reset * 1000).toISOString() : '' };
  }
  return windows;
}

// The desktop remains the sole refresh owner. Never copy or refresh its credentials.
export async function nativeQuotaToken(account, path = join(homedir(), '.codex/auth.json')) {
  const auth = await readJson(path);
  const tokens = auth?.tokens;
  if (!tokens?.access_token || !tokens.id_token) return null;
  try {
    const identity = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url'));
    const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url'));
    if (!account.email || identity.email?.toLowerCase() !== account.email.toLowerCase()
      || identity.email_verified !== true || !Number.isFinite(claims.exp)
      || claims.exp * 1000 <= Date.now() + 30000) return null;
    return { token: tokens.access_token, accountId: tokens.account_id };
  } catch { return null; }
}

export class QuotaService {
  constructor({ root, fetchImpl = fetch, readToken = nativeQuotaToken, readManaged = async () => null, readRegistered = accountToken, now = Date.now } = {}) {
    this.store = new AccountStore(root); this.fetch = fetchImpl; this.readToken = readToken; this.now = now;
    this.cache = new Map(); this.pending = new Map(); this.controller = new AbortController();
    this.readManaged = readManaged;
    this.readRegistered = readRegistered;
  }
  close() { this.controller.abort(); this.cache.clear(); }
  async one(account) {
    const identity = await this.store.read(account.id);
    let auth;
    try {
      auth = await this.readManaged(account);
    } catch {
      return { id: account.id, label: account.label, email: account.email, status: 'error', windows: {},
        source: 'independent-native', message: '独立原生额度授权暂不可用，请重新连接；未改用其他账号', fetchedAt: this.now() };
    }
    try {
      if (!auth && identity.authMode === 'codex-native') auth = {
        token: await this.readRegistered(account.id, { root: this.store.root }), accountId: identity.chatgptAccountId, source: 'registered-native' };
      else if (!auth) {
        const desktop = await this.readToken(identity);
        auth = desktop ? { ...desktop, source: 'desktop-native' } : null;
      }
    } catch {
      return { id: account.id, label: account.label, email: account.email, status: 'error', windows: {},
        message: '当前账号认证失效，请重新登录；不会自动换账号', fetchedAt: this.now() };
    }
    const fingerprint = auth?.token;
    const cached = this.cache.get(account.id);
    if (cached && cached.fingerprint === fingerprint && this.now() - cached.at < 60000) return cached.value;
    if (this.pending.has(account.id)) return this.pending.get(account.id);
    const work = (async () => {
      let result = { id: account.id, label: account.label, email: account.email, status: 'unavailable', windows: {},
        source: auth?.source ?? null,
        message: '请在 Codex 账号与额度中为此账号连接原生额度授权' };
      if (auth) {
        try {
          const headers = { Authorization: `Bearer ${auth.token}`, Accept: 'application/json', 'User-Agent': 'codex-cli' };
          if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId;
          const response = await this.fetch('https://chatgpt.com/backend-api/wham/usage', {
            headers, redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]) });
          if (!response.ok) { result.status = 'error'; result.message = `配额查询 HTTP ${response.status}`; }
          else {
            result.windows = parseQuota(await response.json());
            result.status = Object.keys(result.windows).length ? 'ok' : 'unavailable';
            result.message = result.status === 'ok' ? '' : '官方响应未提供可识别的额度窗口';
          }
        } catch { result.status = 'error'; result.message = '配额查询暂时失败'; }
      }
      result.fetchedAt = this.now();
      if (!this.controller.signal.aborted) this.cache.set(account.id, { at: this.now(), fingerprint, value: result });
      return result;
    })();
    this.pending.set(account.id, work);
    try { return await work; } finally { this.pending.delete(account.id); }
  }
  async snapshot() {
    const accounts = await this.store.list();
    return { accounts: await Promise.all(accounts.map(account => this.one(account))) };
  }
}
