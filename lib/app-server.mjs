import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

export function serverOptions({ executable, codeHome, cwd, token, nativeAuth = false, proxy = {}, strictConfig = codeHome !== join(homedir(), '.codex') }) {
  if (![executable, codeHome, cwd].every(value => typeof value === 'string' && isAbsolute(value))) throw new Error('Codex executable, history home and workspace must be absolute paths');
  if (typeof token !== 'string' || !token) throw new Error('A connected account token is required');
  const shellEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir(), LANG: 'en_US.UTF-8' };
  const env = { ...shellEnv, CODEX_HOME: codeHome, DSH_CODEX_ACCESS_TOKEN: token };
  // Deliberately do not inherit arbitrary provider keys or Codex desktop credentials.
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY']) {
    if (typeof proxy[name] === 'string') env[name] = proxy[name];
  }
  const args = ['app-server', '--listen', 'stdio://', '--strict-config',
    '-c', 'model_provider="dsh_chatgpt_plan"',
    '-c', 'model_providers.dsh_chatgpt_plan.name="ChatGPT plan"',
    '-c', 'model_providers.dsh_chatgpt_plan.base_url="https://api.openai.com/v1"',
    '-c', 'model_providers.dsh_chatgpt_plan.env_key="DSH_CODEX_ACCESS_TOKEN"',
    '-c', 'model_providers.dsh_chatgpt_plan.wire_api="responses"',
    '-c', 'model_providers.dsh_chatgpt_plan.requires_openai_auth=false',
    '-c', 'model_providers.dsh_chatgpt_plan.supports_websockets=false',
    '-c', 'shell_environment_policy.inherit="none"',
    '-c', `shell_environment_policy.set=${JSON.stringify(shellEnv).replace(/"([^"\\]+)":/g, '"$1"=')}`,
    '-c', 'shell_environment_policy.exclude=["DSH_CODEX_ACCESS_TOKEN","CODEX_ACCESS_TOKEN","OPENAI_API_KEY"]'];
  if (nativeAuth) {
    args.splice(4, 14); // Remove seven SIWC provider overrides; retain shell isolation.
    delete env.DSH_CODEX_ACCESS_TOKEN;
  }
  // The installed desktop profile contains legacy fields tolerated by the App.
  // Read it with the same compatibility behavior; never rewrite the user's config.
  if (!strictConfig) args.splice(args.indexOf('--strict-config'), 1);
  return { executable, args, options: { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] } };
}

// One connection owns request IDs and approvals. Notifications are streamed without model polling.
export class AppServer extends EventEmitter {
  constructor({ executable, args, options }, { spawnProcess = spawn, timeoutMs = 30000 } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.approvals = new Map();
    this.seq = 0;
    this.closed = false;
    this.exit = new Promise(resolve => { this.resolveExit = resolve; });
    this.process = spawnProcess(executable, args, options);
    this.process.on('error', () => this.fail(new Error('Codex process failed to start')));
    this.process.on('exit', (code, signal) => {
      this.fail(new Error(`Codex process ended (${signal ?? code})`));
      this.resolveExit({ code, signal });
    });
    this.process.on('close', (code, signal) => {
      this.fail(new Error(`Codex process closed (${signal ?? code})`));
      this.resolveExit({ code, signal });
    });
    this.process.stdin.on('error', () => this.fail(new Error('Codex input stream closed')));
    // Drain stderr to prevent deadlock. Raw diagnostics may contain secrets, so do not publish them.
    this.stderrBytes = 0;
    this.process.stderr.on('data', bytes => { this.stderrBytes += bytes.length; });
    const lines = createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      try { this.receive(JSON.parse(line)); }
      catch { this.fail(new Error('Codex emitted an invalid protocol message')); this.process.kill('SIGTERM'); }
    });
  }
  receive(message) {
    if (this.closed) return;
    if (typeof message.method === 'string') {
      if (message.method === 'serverRequest/resolved') this.approvals.delete(message.params?.requestId);
      if (message.id !== undefined) {
        if (this.approvals.has(message.id)) throw new Error('Duplicate server request');
        this.approvals.set(message.id, message);
        this.emit('request', message);
      } else this.emit('notification', message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    // Do not propagate upstream payloads that may echo inputs or authentication data.
    if (message.error) {
      const reason = /already has an active writer/i.test(message.error.message ?? '')
        ? '；该会话已在另一执行进程中打开，请先在那里结束并关闭会话' : '';
      pending.reject(new Error(`Codex RPC ${pending.method} failed (code ${message.error.code ?? 'unknown'})${reason}`));
    }
    else pending.resolve(message.result);
  }
  write(value) {
    if (this.closed) throw new Error('Codex connection is closed');
    this.process.stdin.write(`${JSON.stringify(value)}\n`);
  }
  rpc(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new Error('Codex connection is closed'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timeout has an unknown outcome; it is never retried automatically.
        this.pending.delete(id);
        reject(new Error(`Codex RPC ${method} timed out; outcome is unknown`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize(experimentalApi = false) {
    const result = await this.rpc('initialize', { clientInfo: { name: 'dsh-codex-workbench', title: 'DSH Codex Workbench', version: '0.1.17' },
      capabilities: { experimentalApi, mcpServerOpenaiFormElicitation: true } });
    this.write({ method: 'initialized' });
    return result;
  }
  answer(id, result) {
    if (!this.approvals.has(id)) throw new Error('Approval is absent or already answered');
    this.write({ id, result });
    this.approvals.delete(id);
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.approvals.clear();
    this.emit('disconnected', { reason: error.message });
  }
  async close() {
    this.fail(new Error('Codex connection closed by owner'));
    this.process.stdin.end();
    const timer = setTimeout(() => this.process.kill('SIGTERM'), 2000);
    const killTimer = setTimeout(() => this.process.kill('SIGKILL'), 5000);
    try { await this.exit; }
    finally { clearTimeout(timer); clearTimeout(killTimer); }
  }
}
