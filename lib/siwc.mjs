import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual, createPublicKey, verify } from 'node:crypto';
import { AccountStore, safeId } from './storage.mjs';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`OpenAI authorization request failed (HTTP ${response.status})`);
  return response.json();
}
export async function verifyIdToken(token, { clientId, nonce, previous, getJson = requestJson, now = Date.now() }) {
  if (typeof token !== 'string' || token.length > 65536) throw new Error('Invalid ID token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid ID token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit) throw new Error('Unsupported ID-token signature');
  const discovery = await getJson(`${ISSUER}/.well-known/openid-configuration`);
  if (discovery.issuer !== ISSUER || new URL(discovery.jwks_uri).origin !== ISSUER) throw new Error('Untrusted OpenID discovery');
  const jwks = await getJson(discovery.jwks_uri);
  const jwk = jwks.keys?.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
  if (!jwk || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error('ID-token signature verification failed');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId)
    || !Number.isFinite(claims.exp) || claims.exp <= now / 1000 || (claims.nbf && claims.nbf > now / 1000 + 30)
    || !claims.sub || (nonce !== undefined && !equal(claims.nonce, nonce))) throw new Error('ID-token identity validation failed');
  if (previous && (claims.sub !== previous.subject || claims.iss !== previous.issuer)) throw new Error('Returning login selected a different identity');
  return claims;
}
function credentialRecord(tokens, identity, { clientId, hostId, label, old }) {
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.token_type?.toLowerCase() !== 'bearer'
    || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error('Incomplete token response');
  const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : old?.scopes;
  if (!scopes?.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke')) throw new Error('ChatGPT plan usage was not granted');
  return { label, issuer: identity.iss, subject: identity.sub, email: identity.email ?? old?.email ?? null,
    clientId, hostId, idToken: tokens.id_token ?? old?.idToken, accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? old?.refreshToken, scopes,
    expiresAt: Date.now() + tokens.expires_in * 1000, savedAt: new Date().toISOString() };
}

// The returned URL contains state/PKCE, never an access or refresh token.
export async function startLogin({ id, label = id, root, timeoutMs = 300000, getJson = requestJson } = {}) {
  safeId(id);
  const store = new AccountStore(root);
  const hostId = await store.hostId();
  const release = await store.lock(id);
  let previous;
  try { previous = await store.read(id); }
  catch (error) { await release(); throw error; }
  const state = random(), nonce = random(), verifier = random();
  let settle, reject, claimed = false, timer, closed = false;
  const completion = new Promise((resolve, fail) => { settle = resolve; reject = fail; });
  completion.catch(() => {});
  const server = createServer();
  const finish = async (error, value) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.close();
    server.closeIdleConnections();
    await release();
    if (error) reject(error); else settle(value);
  };
  try {
    await new Promise((resolve, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', resolve); });
    const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
    const params = new URLSearchParams({ client_id: previous?.clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectUri, scope: SCOPE,
      resource: RESOURCE, state, nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    if (!previous) params.set('agent_name_hint', 'dsh-codex-workbench');
    // Do not expose retained ID tokens through URLs printed by the CLI.
    if (previous?.email) params.set('login_hint', previous.email);
    const authUrl = `${ISSUER}/api/accounts/authorize?${params}`;
    server.on('request', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      const url = new URL(req.url, redirectUri);
      if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404).end('Not found'); return; }
      if (req.headers.host !== new URL(redirectUri).host || !equal(url.searchParams.get('state'), state)) { res.writeHead(400).end('Invalid authorization state'); return; }
      if (claimed || closed) { res.writeHead(409).end('Authorization already handled'); return; }
      claimed = true;
      try {
        if (url.searchParams.has('error')) throw new Error('ChatGPT authorization was declined or failed');
        const clientId = url.searchParams.get('client_id') ?? previous?.clientId;
        if (!clientId || clientId === 'dynamic_agent_client' || !/^[\w-]{1,200}$/.test(clientId)
          || (previous && clientId !== previous.clientId)) throw new Error('Registration returned an invalid client ID');
        const code = url.searchParams.get('code');
        if (!code) throw new Error('Authorization code is missing');
        const tokens = await getJson(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
            code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }).toString() });
        const identity = await verifyIdToken(tokens.id_token, { clientId, nonce, previous, getJson });
        const record = credentialRecord(tokens, identity, { clientId, hostId, label, old: previous });
        if (!record.refreshToken) throw new Error('Renewable session was not granted');
        if (closed) throw new Error('Authorization attempt expired');
        await store.save(id, record);
        res.end('ChatGPT account connected. You can close this tab and return to DSH.');
        await finish(null, { id, email: record.email, label: record.label, planUsage: true });
      } catch (error) {
        res.writeHead(400).end('Authorization could not be completed. Return to the local tool for status.');
        await finish(new Error(error.message.startsWith('OpenAI authorization') ? error.message : 'Authorization validation failed; no credentials were replaced'));
      }
    });
    timer = setTimeout(() => { void finish(new Error('Login expired; start a fresh authorization')); }, timeoutMs);
    return { authUrl, redirectUri, completion, cancel: () => finish(new Error('Login cancelled')) };
  } catch (error) { await finish(error); throw error; }
}

export async function accountToken(id, { root, getJson = requestJson } = {}) {
  const store = new AccountStore(root);
  const release = await store.lock(id, { waitMs: 20000 });
  try {
    const saved = await store.read(id);
    if (!saved) throw new Error(`Account ${safeId(id)} is not connected; run login first`);
    if (saved.expiresAt > Date.now() + 60000) return saved.accessToken;
    if (saved.authMode === 'codex-native') {
      const tokens = await getJson(`${ISSUER}/oauth/token`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: saved.clientId,
          refresh_token: saved.refreshToken, scope: 'openid profile email' }).toString() });
      if (!tokens.access_token || !tokens.id_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error('Incomplete native token response');
      const identity = await verifyIdToken(tokens.id_token, { clientId: saved.clientId, previous: saved, getJson });
      const claims = identity['https://api.openai.com/auth'];
      if (claims?.chatgpt_account_id !== saved.chatgptAccountId) throw new Error('Native account changed during refresh');
      await store.save(id, { ...saved, accessToken: tokens.access_token, idToken: tokens.id_token,
        refreshToken: tokens.refresh_token ?? saved.refreshToken, expiresAt: Date.now() + tokens.expires_in * 1000,
        savedAt: new Date().toISOString() });
      return tokens.access_token;
    }
    const tokens = await getJson(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: saved.clientId,
        refresh_token: saved.refreshToken, resource: RESOURCE }).toString() });
    const identity = tokens.id_token ? await verifyIdToken(tokens.id_token, { clientId: saved.clientId, previous: saved, getJson })
      : { iss: saved.issuer, sub: saved.subject, email: saved.email };
    const next = credentialRecord(tokens, identity, { clientId: saved.clientId, hostId: saved.hostId, label: saved.label, old: saved });
    await store.save(id, next);
    return next.accessToken;
  } finally { await release(); }
}
