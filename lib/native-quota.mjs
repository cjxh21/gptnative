import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { AccountStore, privateDirectory, readJson, atomicJson, safeId, acquireLock } from './storage.mjs';
import { AppServer, serverOptions } from './app-server.mjs';
import { nativeQuotaToken } from './quota.mjs';

// Owns independent native credential refresh; callers may use the resulting access token
// for quotas and an external-token engine login. Never imports desktop/CC Switch tokens.
// Codex owns persistence and refresh in each credential home. No thread or turn RPC is exposed.
export class NativeQuotaAccounts extends EventEmitter {
  constructor({ root, executable = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', serverFactory = spec => new AppServer(spec), now = Date.now, loginTimeoutMs = 480000 } = {}) {
    super(); Object.assign(this, { root, executable, serverFactory, now, loginTimeoutMs });
    this.store = new AccountStore(root); this.cache = new Map(); this.reading = new Map();
    this.servers = new Set(); this.messages = new Map(); this.closed = false;
    this.releases = new Map();
  }
  directory(id) { return join(this.root, 'quota-auth', safeId(id)); }
  async binding(account) {
    const value = await readJson(join(this.directory(account.id), 'binding.json'));
    if (!value) return null;
    if (!/^[0-9a-f-]{36}$/.test(value.home ?? '') || value.email !== account.email?.toLowerCase()) throw new Error('额度授权身份已变化，请重新连接');
    return value;
  }
  async statuses(accounts) {
    return Promise.all(accounts.map(async account => {
      const registered = await this.store.read(account.id);
      const nativeManaged = registered?.authMode === 'codex-native';
      let independent = false; try { independent = !!await this.binding(account); } catch {}
      const desktop = !independent && !nativeManaged && !!await nativeQuotaToken(account);
      const connected = independent || nativeManaged || desktop;
      return { id: account.id, connected, nativeManaged, pending: this.login?.id === account.id,
        source: independent ? 'independent-native' : nativeManaged ? 'registered-native' : desktop ? 'desktop-native' : null,
        message: this.messages.get(account.id) || (independent ? '已连接独立原生额度授权' : nativeManaged ? '原生额度授权可用' : desktop ? '当前使用桌面同身份授权；可连接独立授权' : '可单独连接额度，不改变对话登录') };
    }));
  }
  async open(home) {
    if (this.closed) throw new Error('额度服务已卸载');
    await privateDirectory(home);
    const release = await acquireLock(join(home, 'quota-owner.lock'), { waitMs: 15000 });
    const spec = serverOptions({ executable: this.executable, codeHome: home, cwd: home, token: 'unused', nativeAuth: true });
    spec.args.push('-c', 'cli_auth_credentials_store="file"');
    let server;
    try { server = this.serverFactory(spec); } catch (error) { await release(); throw error; }
    this.servers.add(server); this.releases.set(server, release);
    try { await server.initialize(); if (this.closed) throw new Error('额度服务已卸载'); return server; }
    catch (error) { await this.finish(server); throw error; }
  }
  async finish(server) {
    if (!this.servers.delete(server)) return;
    const release = this.releases.get(server); this.releases.delete(server);
    try { await server.close(); } finally { await release?.(); }
  }
  async verify(server, account) {
    const { account: native } = await server.rpc('account/read', { refreshToken: true });
    if (native?.type !== 'chatgpt' || native.email?.toLowerCase() !== account.email?.toLowerCase()) throw new Error('登录账号与所选账号不一致；未替换现有授权，请重新选择正确账号');
  }
  async start(id, registration = null) {
    if (this.login) throw new Error('已有原生额度登录正在进行');
    let account = await this.store.read(safeId(id));
    const isNew = !account;
    if (isNew && registration) {
      if (typeof registration.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(registration.email) || registration.email.length > 254) throw new Error('请输入要登录的账号邮箱以校验身份');
      account = { label: String(registration.label || id).slice(0, 100), email: registration.email.toLowerCase(), authMode: 'codex-native' };
    }
    if (!account?.email) throw new Error('请先连接此账号的对话身份');
    if (this.login) throw new Error('已有原生额度登录正在进行');
    account.id = id;
    const attempt = { id, home: randomUUID(), settled: false, account, isNew };
    this.login = attempt; this.messages.delete(id); this.emit('changed');
    const home = join(this.directory(id), attempt.home);
    try {
      const server = attempt.server = await this.open(home);
      if (attempt.settled || this.closed) { await this.finish(server); await rm(home, { recursive: true, force: true }); throw new Error('原生额度登录已取消'); }
      server.on('notification', event => {
        if (event.method === 'account/login/completed' && (!attempt.loginId || event.params.loginId === attempt.loginId)) {
          void this.complete(attempt, account, event.params.success).catch(() => {});
        }
      });
      server.on('disconnected', () => { if (!attempt.settled) void this.complete(attempt, account, false); });
      const result = await server.rpc('account/login/start', { type: 'chatgpt' });
      if (attempt.settled || this.closed) throw new Error('原生额度登录已结束');
      const url = new URL(result.authUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com') throw new Error('官方授权地址异常');
      attempt.loginId = result.loginId;
      attempt.timer = setTimeout(() => { void this.cancel(id); }, this.loginTimeoutMs); attempt.timer.unref?.();
      return { authUrl: result.authUrl, accountId: id };
    } catch (error) { await this.complete(attempt, account, false); throw error; }
  }
  async complete(attempt, account, success) {
    if (attempt.settled) return;
    attempt.settled = true; clearTimeout(attempt.timer);
    let saved = false;
    try {
      if (!success || this.closed) throw new Error('原生额度登录未完成或已取消');
      await this.verify(attempt.server, account);
      if (this.closed) throw new Error('额度服务已卸载');
      if (attempt.isNew) {
        if (await this.store.read(account.id)) throw new Error('同名账号已被其他登录登记，未覆盖');
        await this.store.save(account.id, { label: account.label, email: account.email, authMode: 'codex-native', savedAt: Date.now() });
      }
      await atomicJson(join(this.directory(account.id), 'binding.json'), { home: attempt.home, email: account.email.toLowerCase() });
      saved = true; this.cache.delete(account.id); this.messages.set(account.id, '原生额度授权已连接，对话登录保持不变');
    } catch (error) { this.messages.set(account.id, error.message); }
    finally {
      if (attempt.server) await this.finish(attempt.server).catch(() => {});
      if (!saved) await rm(join(this.directory(account.id), attempt.home), { recursive: true, force: true });
      if (this.login === attempt) this.login = null;
      this.emit('changed');
    }
  }
  async cancel(id) {
    const attempt = this.login; if (!attempt || attempt.id !== id) return;
    const account = attempt.account ?? await this.store.read(id); account.id = id;
    if (attempt.server && attempt.loginId) await attempt.server.rpc('account/login/cancel', { loginId: attempt.loginId }).catch(() => {});
    await this.complete(attempt, account, false);
  }
  async read(account) {
    const binding = await this.binding(account); if (!binding) return null;
    const cached = this.cache.get(account.id);
    if (cached?.home === binding.home && this.now() - cached.at < 60000 && cached.expiresAt > this.now() + 30000) return cached.value;
    if (this.reading.has(account.id)) return this.reading.get(account.id);
    const pending = (async () => {
      const server = await this.open(join(this.directory(account.id), binding.home));
      try {
        await this.verify(server, account);
        const saved = await nativeQuotaToken(account, join(this.directory(account.id), binding.home, 'auth.json'));
        if (!saved) throw new Error('原生凭据未保存或身份不匹配');
        const value = { ...saved, source: 'independent-native' };
        const expiresAt = JSON.parse(Buffer.from(saved.token.split('.')[1], 'base64url')).exp * 1000;
        this.cache.set(account.id, { home: binding.home, at: this.now(), expiresAt, value }); return value;
      } finally { await this.finish(server); }
    })();
    this.reading.set(account.id, pending);
    try { return await pending; } finally { this.reading.delete(account.id); }
  }
  async close() {
    this.closed = true;
    if (this.login) await this.cancel(this.login.id);
    await Promise.allSettled([...this.servers].map(server => this.finish(server)));
  }
}
