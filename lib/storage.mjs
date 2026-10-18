import { mkdir, readFile, writeFile, rename, chmod, lstat, unlink, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

export const defaultRoot = () => join(homedir(), '.dsh', 'storages', 'dsh-codex-workbench');
export function safeId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) throw new Error('Invalid local identifier');
  return value;
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Private storage must be a directory');
  await chmod(path, 0o700);
}
export async function readJson(path, fallback = null) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Private record must be a regular file');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
export async function atomicJson(path, value) {
  await privateDirectory(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}

// Locks are never silently stolen: stale/uncertain ownership requires an explicit recovery.
export async function acquireLock(path, { waitMs = 0 } = {}) {
  await privateDirectory(dirname(path));
  let handle;
  const deadline = Date.now() + waitMs;
  while (!handle) {
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Storage is busy; another process or unrecovered lock owns it');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close();
    await unlink(path);
  };
}

export class AccountStore {
  constructor(root = defaultRoot()) { this.root = root; }
  path(id) { return join(this.root, 'accounts', `${safeId(id)}.json`); }
  async hostId() {
    await privateDirectory(this.root);
    const release = await acquireLock(join(this.root, 'host.lock'), { waitMs: 5000 });
    try {
      const path = join(this.root, 'host.json');
      const saved = await readJson(path);
      if (saved) return saved.id;
      const id = `urn:uuid:${randomUUID()}`;
      await atomicJson(path, { id });
      return id;
    } finally { await release(); }
  }
  async read(id) { return readJson(this.path(id)); }
  async save(id, record) { await atomicJson(this.path(id), record); }
  async lock(id, options) { return acquireLock(`${this.path(id)}.lock`, options); }
  async list() {
    const { readdir } = await import('node:fs/promises');
    let names;
    try { names = await readdir(join(this.root, 'accounts')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(x => /^[\w-]+\.json$/.test(x)).map(async name => {
      const id = name.slice(0, -5);
      const account = await this.read(id);
      return { id, label: account.label, email: account.email, planUsage: account.authMode === 'codex-native' || account.scopes?.includes('chatgpt.tokens.use.direct') === true,
        expiresAt: account.expiresAt, savedAt: account.savedAt };
    }));
  }
}
