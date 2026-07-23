import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";

const MAX_BODY_BYTES = 64 * 1024;
const CHALLENGE_TTL_MS = 2 * 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;
const MAX_REGISTRATION_TTL_MS = 10 * 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const FLOW_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

type StoredCredential = Readonly<{
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports: readonly string[];
  deviceType: string;
  backedUp: boolean;
}>;

export type PasskeyRegistrationResult =
  | Readonly<{ verified: false }>
  | Readonly<{ verified: true; credential: StoredCredential }>;

export type PasskeyAuthenticationResult =
  | Readonly<{ verified: false }>
  | Readonly<{ verified: true; newCounter: number; deviceType: string; backedUp: boolean }>;

export type PasskeyEngine = Readonly<{
  registrationOptions(input: Readonly<{
    challenge: string;
    rpId: string;
    rpName: string;
    userId: Uint8Array;
    userName: string;
    excludeCredentials: readonly StoredCredential[];
  }>): Promise<unknown>;
  verifyRegistration(input: Readonly<{
    challenge: string;
    expectedOrigin: string;
    rpId: string;
    response: unknown;
  }>): Promise<PasskeyRegistrationResult>;
  authenticationOptions(input: Readonly<{
    challenge: string;
    rpId: string;
    credentials: readonly StoredCredential[];
  }>): Promise<unknown>;
  verifyAuthentication(input: Readonly<{
    challenge: string;
    expectedOrigin: string;
    rpId: string;
    response: unknown;
    credential: StoredCredential;
  }>): Promise<PasskeyAuthenticationResult>;
}>;

export type PasskeyAuthOptions = Readonly<{
  databasePath: string;
  realmId: string;
  realmName: string;
  publicOrigin: string;
  rpId: string;
  engine?: PasskeyEngine;
  now?: () => number;
  allowInsecureLoopback?: boolean;
}>;

export type RealmSession = Readonly<{ id: string; realmId: string; expiresAt: number }>;

export type PasskeyAuth = Readonly<{
  publicOrigin: string;
  issueRegistrationUrl(options?: Readonly<{ ttlMs?: number }>): string;
  handle(request: Request): Promise<Response | undefined>;
  sessionFor(request: Request): RealmSession | undefined;
  sessionById(sessionId: string): RealmSession | undefined;
  onSessionInvalidated(listener: (sessionId: string) => void): () => void;
  close(): void;
}>;

type GrantRow = { token_hash: string; expires_at: number; consumed_at: number | null };
type CeremonyRow = { id: string; kind: string; token_hash: string | null; challenge: string; expires_at: number; consumed_at: number | null };
type CredentialRow = { id: string; public_key: Uint8Array; counter: number; transports_json: string; device_type: string; backed_up: number };
type SessionRow = { expires_at: number };

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

async function boundedJson(request: Request): Promise<Record<string, unknown> | undefined> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return undefined;
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return undefined;
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(next.value);
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function parseTransports(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) return Object.freeze([]);
    return Object.freeze(parsed);
  } catch {
    return Object.freeze([]);
  }
}

function storedCredential(row: CredentialRow): StoredCredential {
  return Object.freeze({
    id: row.id,
    publicKey: new Uint8Array(row.public_key),
    counter: row.counter,
    transports: parseTransports(row.transports_json),
    deviceType: row.device_type,
    backedUp: row.backed_up === 1,
  });
}

const defaultEngine: PasskeyEngine = Object.freeze({
  async registrationOptions(input) {
    return generateRegistrationOptions({
      rpName: input.rpName,
      rpID: input.rpId,
      userID: Uint8Array.from(input.userId),
      userName: input.userName,
      userDisplayName: input.userName,
      challenge: input.challenge,
      timeout: CHALLENGE_TTL_MS,
      attestationType: "none",
      excludeCredentials: input.excludeCredentials.map((entry) => ({
        id: entry.id,
        transports: entry.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
  },
  async verifyRegistration(input) {
    try {
      const result = await verifyRegistrationResponse({
        response: input.response as RegistrationResponseJSON,
        expectedChallenge: input.challenge,
        expectedOrigin: input.expectedOrigin,
        expectedRPID: input.rpId,
        requireUserPresence: true,
        requireUserVerification: true,
      });
      if (!result.verified || !result.registrationInfo) return Object.freeze({ verified: false });
      const info = result.registrationInfo;
      return Object.freeze({
        verified: true,
        credential: Object.freeze({
          id: info.credential.id,
          publicKey: new Uint8Array(info.credential.publicKey),
          counter: info.credential.counter,
          transports: Object.freeze([...(info.credential.transports ?? [])]),
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
        }),
      });
    } catch {
      return Object.freeze({ verified: false });
    }
  },
  async authenticationOptions(input) {
    return generateAuthenticationOptions({
      rpID: input.rpId,
      challenge: input.challenge,
      timeout: CHALLENGE_TTL_MS,
      userVerification: "required",
      allowCredentials: input.credentials.map((entry) => ({
        id: entry.id,
        transports: entry.transports as AuthenticatorTransportFuture[],
      })),
    });
  },
  async verifyAuthentication(input) {
    try {
      const credential: WebAuthnCredential = {
        id: input.credential.id,
        publicKey: Uint8Array.from(input.credential.publicKey),
        counter: input.credential.counter,
        transports: input.credential.transports as AuthenticatorTransportFuture[],
      };
      const result = await verifyAuthenticationResponse({
        response: input.response as AuthenticationResponseJSON,
        expectedChallenge: input.challenge,
        expectedOrigin: input.expectedOrigin,
        expectedRPID: input.rpId,
        credential,
        requireUserVerification: true,
      });
      if (!result.verified) return Object.freeze({ verified: false });
      return Object.freeze({
        verified: true,
        newCounter: result.authenticationInfo.newCounter,
        deviceType: result.authenticationInfo.credentialDeviceType,
        backedUp: result.authenticationInfo.credentialBackedUp,
      });
    } catch {
      return Object.freeze({ verified: false });
    }
  },
});

function authHeaders(): HeadersInit {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "publickey-credentials-create=(self), publickey-credentials-get=(self)",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function authPage(kind: "register" | "login", realmName: string): Response {
  const action = kind === "register" ? "Register passkey" : "Sign in with passkey";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${action} · ${realmName}</title><style>
:root{color-scheme:light;--realm-ink:#14202b;--realm-muted:#667381;--realm-line:#d9e0e6;--realm-surface:#fff;--realm-canvas:#f4f7f9;--realm-accent:#137a92;--realm-accent-hover:#0d6074;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{min-height:100%;margin:0}body{background:var(--realm-canvas);color:var(--realm-ink);-webkit-font-smoothing:antialiased}.auth-shell{min-height:100vh;display:grid;grid-template-rows:auto 1fr auto}.auth-header,.auth-footer{display:flex;align-items:center;justify-content:space-between;padding:24px clamp(24px,5vw,72px);font-size:12px;letter-spacing:.14em;text-transform:uppercase}.auth-header{border-bottom:1px solid var(--realm-line);font-weight:700}.auth-header span:last-child,.auth-footer{color:var(--realm-muted)}.auth-main{display:grid;place-items:center;padding:48px 24px}.auth-card{width:min(100%,480px);padding:clamp(32px,6vw,56px);background:var(--realm-surface);border:1px solid var(--realm-line);border-radius:20px;box-shadow:0 24px 70px rgba(20,32,43,.09)}.auth-eyebrow{margin:0 0 18px;color:var(--realm-accent);font-size:12px;font-weight:750;letter-spacing:.14em;text-transform:uppercase}.auth-card h1{margin:0;font-size:clamp(34px,7vw,54px);font-weight:540;letter-spacing:-.045em;line-height:1.02}.auth-copy{margin:20px 0 32px;color:var(--realm-muted);font-size:16px;line-height:1.65}.auth-action{width:100%;min-height:52px;border:0;border-radius:12px;padding:14px 20px;background:var(--realm-accent);color:#fff;font:inherit;font-weight:700;cursor:pointer;transition:background-color .16s ease,transform .16s ease}.auth-action:hover{background:var(--realm-accent-hover)}.auth-action:active{transform:translateY(1px)}.auth-action:disabled{cursor:wait;opacity:.65}.auth-action:focus-visible{outline:3px solid rgba(19,122,146,.28);outline-offset:3px}.auth-status{min-height:24px;margin:18px 0 0;color:#a13b35;font-size:14px;line-height:1.5}.auth-footer{border-top:1px solid var(--realm-line);letter-spacing:0;text-transform:none}@media(max-width:540px){.auth-header{align-items:flex-start;gap:8px;flex-direction:column}.auth-card{border-radius:16px}.auth-footer{align-items:flex-start;gap:6px;flex-direction:column}}@media(prefers-reduced-motion:reduce){.auth-action{transition:none}}
</style></head><body data-passkey-page="${kind}"><div class="auth-shell"><header class="auth-header"><span>Klivcore Realm</span><span>Identity authority</span></header><main class="auth-main"><section class="auth-card" aria-labelledby="realm-title"><p class="auth-eyebrow">Secure Realm access</p><h1 id="realm-title">${realmName}</h1><p class="auth-copy">Use a passkey to continue to this Realm. Authentication is scoped to this exact Realm origin.</p><button class="auth-action" type="button" id="passkey-action">${action}</button><p class="auth-status" id="status" role="status" aria-live="polite"></p></section></main><footer class="auth-footer"><span>Private by default</span><span>Passkey-protected access</span></footer></div><script src="/auth/passkey.js" defer></script></body></html>`;
  return new Response(html, { headers: { ...authHeaders(), "content-type": "text/html; charset=utf-8" } });
}

const PASSKEY_BROWSER_JS = String.raw`(() => {
  const body = document.body;
  const button = document.querySelector('#passkey-action');
  const status = document.querySelector('#status');
  const b64 = (value) => { const input = value.replace(/-/g, '+').replace(/_/g, '/'); const raw = atob(input + '='.repeat((4 - input.length % 4) % 4)); return Uint8Array.from(raw, c => c.charCodeAt(0)); };
  const enc = (value) => { const bytes = new Uint8Array(value); let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte); return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); };
  const creation = (value) => PublicKeyCredential.parseCreationOptionsFromJSON ? PublicKeyCredential.parseCreationOptionsFromJSON(value) : { ...value, challenge: b64(value.challenge), user: { ...value.user, id: b64(value.user.id) }, excludeCredentials: (value.excludeCredentials || []).map(x => ({ ...x, id: b64(x.id) })) };
  const request = (value) => PublicKeyCredential.parseRequestOptionsFromJSON ? PublicKeyCredential.parseRequestOptionsFromJSON(value) : { ...value, challenge: b64(value.challenge), allowCredentials: (value.allowCredentials || []).map(x => ({ ...x, id: b64(x.id) })) };
  const serialize = (credential) => ({ id: credential.id, rawId: enc(credential.rawId), type: credential.type, authenticatorAttachment: credential.authenticatorAttachment, clientExtensionResults: credential.getClientExtensionResults(), response: credential.response.attestationObject ? { clientDataJSON: enc(credential.response.clientDataJSON), attestationObject: enc(credential.response.attestationObject), transports: credential.response.getTransports ? credential.response.getTransports() : [] } : { clientDataJSON: enc(credential.response.clientDataJSON), authenticatorData: enc(credential.response.authenticatorData), signature: enc(credential.response.signature), userHandle: credential.response.userHandle ? enc(credential.response.userHandle) : undefined } });
  async function post(path, value) { const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }); if (!response.ok) throw new Error('Request failed (' + response.status + ')'); return response.status === 204 ? undefined : response.json(); }
  button.addEventListener('click', async () => {
    button.disabled = true; status.textContent = 'Waiting for your authenticator…';
    try {
      if (body.dataset.passkeyPage === 'register') {
        const token = new URL(location.href).hash.slice('#token='.length); history.replaceState(null, '', '/auth/register');
        if (!token) throw new Error('Registration capability is missing');
        const flow = await post('/v1/auth/register/options', { token });
        const credential = await navigator.credentials.create({ publicKey: creation(flow.publicKey) });
        if (!credential) throw new Error('Passkey registration was cancelled');
        await post('/v1/auth/register/verify', { token, flowId: flow.flowId, credential: serialize(credential) });
      } else {
        const flow = await post('/v1/auth/login/options', {});
        const credential = await navigator.credentials.get({ publicKey: request(flow.publicKey) });
        if (!credential) throw new Error('Passkey authentication was cancelled');
        await post('/v1/auth/login/verify', { flowId: flow.flowId, credential: serialize(credential) });
      }
      location.replace('/');
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); button.disabled = false; }
  });
})();`;

export function createPasskeyAuth(options: PasskeyAuthOptions): PasskeyAuth {
  const now = options.now ?? Date.now;
  const publicUrl = new URL(options.publicOrigin);
  const isLoopback = publicUrl.hostname === "127.0.0.1" || publicUrl.hostname === "localhost";
  if (publicUrl.origin !== options.publicOrigin || publicUrl.username || publicUrl.password
    || (publicUrl.protocol !== "https:" && !(options.allowInsecureLoopback && publicUrl.protocol === "http:" && isLoopback))) {
    throw new TypeError("passkey public origin must be an exact HTTPS origin or an explicitly allowed loopback origin");
  }
  if (options.rpId !== publicUrl.hostname || !/^[A-Za-z0-9.-]{1,253}$/.test(options.rpId)) {
    throw new TypeError("passkey RP ID must exactly match the configured public origin hostname");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.realmId) || !options.realmName || options.realmName.length > 256) {
    throw new TypeError("passkey Realm identity is invalid");
  }
  const databasePath = resolve(options.databasePath);
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new Database(databasePath, { create: true, strict: true });
  try { chmodSync(databasePath, 0o600); } catch { database.close(); throw new Error("passkey database permissions could not be restricted"); }
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS registration_grants (
      token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ceremonies (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('register', 'login')),
      token_hash TEXT,
      challenge TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL CHECK(counter >= 0),
      transports_json TEXT NOT NULL,
      device_type TEXT NOT NULL,
      backed_up INTEGER NOT NULL CHECK(backed_up IN (0, 1)),
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
  `);
  const engine = options.engine ?? defaultEngine;
  const invalidationListeners = new Set<(sessionId: string) => void>();
  const realmUserId = createHash("sha256").update(`klivcore-realm-user\0${options.realmId}`).digest();
  const cookieName = publicUrl.protocol === "https:"
    ? `__Host-kc-${options.realmId}-session`
    : `kc-${options.realmId}-session`;
  const cookie = (token: string) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${publicUrl.protocol === "https:" ? "; Secure" : ""}`;

  const allCredentials = () => database.query<CredentialRow, []>("SELECT id, public_key, counter, transports_json, device_type, backed_up FROM credentials ORDER BY id LIMIT 32").all().map(storedCredential);
  const createSession = () => {
    const token = randomToken();
    const createdAt = now();
    database.query("INSERT INTO sessions(token_hash, expires_at, created_at) VALUES (?, ?, ?)").run(tokenHash(token), createdAt + SESSION_TTL_MS, createdAt);
    return token;
  };
  const exactOrigin = (request: Request) => request.headers.get("origin") === options.publicOrigin;
  const claimCeremony = (id: string, kind: "register" | "login", registrationTokenHash?: string): CeremonyRow | undefined => {
    const timestamp = now();
    const updated = registrationTokenHash
      ? database.query("UPDATE ceremonies SET consumed_at = ? WHERE id = ? AND kind = ? AND token_hash = ? AND consumed_at IS NULL AND expires_at > ?").run(timestamp, id, kind, registrationTokenHash, timestamp)
      : database.query("UPDATE ceremonies SET consumed_at = ? WHERE id = ? AND kind = ? AND token_hash IS NULL AND consumed_at IS NULL AND expires_at > ?").run(timestamp, id, kind, timestamp);
    if (updated.changes !== 1) return undefined;
    return database.query<CeremonyRow, [string]>("SELECT id, kind, token_hash, challenge, expires_at, consumed_at FROM ceremonies WHERE id = ?").get(id) ?? undefined;
  };

  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/auth/register") return authPage("register", options.realmName);
    if (request.method === "GET" && url.pathname === "/auth/login") return authPage("login", options.realmName);
    if (request.method === "GET" && url.pathname === "/auth/passkey.js") {
      return new Response(PASSKEY_BROWSER_JS, { headers: { ...authHeaders(), "content-type": "text/javascript; charset=utf-8" } });
    }
    if (!url.pathname.startsWith("/v1/auth/")) return undefined;
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!exactOrigin(request)) return json({ error: "forbidden" }, 403);
    const body = await boundedJson(request);
    if (!body) return json({ error: "invalid request" }, 400);
    const timestamp = now();

    if (url.pathname === "/v1/auth/register/options") {
      if (!exactKeys(body, ["token"]) || typeof body.token !== "string" || !TOKEN_PATTERN.test(body.token)) return json({ error: "invalid request" }, 400);
      const hash = tokenHash(body.token);
      const grant = database.query<GrantRow, [string]>("SELECT token_hash, expires_at, consumed_at FROM registration_grants WHERE token_hash = ?").get(hash);
      if (!grant || grant.consumed_at !== null || grant.expires_at <= timestamp) return json({ error: "unauthorized" }, 401);
      const challenge = randomToken();
      const flowId = randomToken(18);
      const publicKey = await engine.registrationOptions({
        challenge,
        rpId: options.rpId,
        rpName: options.realmName,
        userId: realmUserId,
        userName: `${options.realmId} owner`,
        excludeCredentials: allCredentials(),
      });
      database.query("INSERT INTO ceremonies(id, kind, token_hash, challenge, expires_at, consumed_at) VALUES (?, 'register', ?, ?, ?, NULL)")
        .run(flowId, hash, challenge, timestamp + CHALLENGE_TTL_MS);
      return json({ flowId, publicKey });
    }

    if (url.pathname === "/v1/auth/register/verify") {
      if (!exactKeys(body, ["token", "flowId", "credential"])
        || typeof body.token !== "string" || !TOKEN_PATTERN.test(body.token)
        || typeof body.flowId !== "string" || !FLOW_PATTERN.test(body.flowId)) return json({ error: "invalid request" }, 400);
      const hash = tokenHash(body.token);
      const ceremony = claimCeremony(body.flowId, "register", hash);
      if (!ceremony) return json({ error: "unauthorized" }, 401);
      const result = await engine.verifyRegistration({ challenge: ceremony.challenge, expectedOrigin: options.publicOrigin, rpId: options.rpId, response: body.credential });
      if (!result.verified) return json({ error: "unauthorized" }, 401);
      let sessionToken: string | undefined;
      const commit = database.transaction(() => {
        const consumed = database.query("UPDATE registration_grants SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?")
          .run(timestamp, hash, timestamp);
        if (consumed.changes !== 1) return;
        const entry = result.credential;
        database.query("INSERT INTO credentials(id, public_key, counter, transports_json, device_type, backed_up, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(entry.id, entry.publicKey, entry.counter, JSON.stringify(entry.transports), entry.deviceType, entry.backedUp ? 1 : 0, timestamp, timestamp);
        sessionToken = createSession();
      });
      try { commit.immediate(); } catch { return json({ error: "unauthorized" }, 401); }
      if (!sessionToken) return json({ error: "unauthorized" }, 401);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store", "set-cookie": cookie(sessionToken) } });
    }

    if (url.pathname === "/v1/auth/login/options") {
      if (!exactKeys(body, [])) return json({ error: "invalid request" }, 400);
      const credentials = allCredentials();
      if (credentials.length === 0) return json({ error: "passkey registration required" }, 409);
      const challenge = randomToken();
      const flowId = randomToken(18);
      const publicKey = await engine.authenticationOptions({ challenge, rpId: options.rpId, credentials });
      database.query("INSERT INTO ceremonies(id, kind, token_hash, challenge, expires_at, consumed_at) VALUES (?, 'login', NULL, ?, ?, NULL)")
        .run(flowId, challenge, timestamp + CHALLENGE_TTL_MS);
      return json({ flowId, publicKey });
    }

    if (url.pathname === "/v1/auth/login/verify") {
      if (!exactKeys(body, ["flowId", "credential"]) || typeof body.flowId !== "string" || !FLOW_PATTERN.test(body.flowId)) return json({ error: "invalid request" }, 400);
      const ceremony = claimCeremony(body.flowId, "login");
      if (!ceremony) return json({ error: "unauthorized" }, 401);
      const credentials = allCredentials();
      const responseId = body.credential && typeof body.credential === "object" && !Array.isArray(body.credential)
        ? (body.credential as Record<string, unknown>).id
        : undefined;
      const credential = typeof responseId === "string"
        ? credentials.find((entry) => entry.id === responseId)
        : credentials.length === 1 ? credentials[0] : undefined;
      if (!credential) return json({ error: "unauthorized" }, 401);
      const result = await engine.verifyAuthentication({ challenge: ceremony.challenge, expectedOrigin: options.publicOrigin, rpId: options.rpId, response: body.credential, credential });
      if (!result.verified) return json({ error: "unauthorized" }, 401);
      let sessionToken: string | undefined;
      const commit = database.transaction(() => {
        database.query("UPDATE credentials SET counter = ?, device_type = ?, backed_up = ?, last_used_at = ? WHERE id = ?")
          .run(result.newCounter, result.deviceType, result.backedUp ? 1 : 0, timestamp, credential.id);
        sessionToken = createSession();
      });
      commit.immediate();
      return new Response(null, { status: 204, headers: { "cache-control": "no-store", "set-cookie": cookie(sessionToken!) } });
    }

    if (url.pathname === "/v1/auth/logout") {
      if (!exactKeys(body, [])) return json({ error: "invalid request" }, 400);
      const session = sessionFor(request);
      if (!session) return json({ error: "unauthorized" }, 401);
      const deleted = database.query("DELETE FROM sessions WHERE token_hash = ?").run(session.id);
      if (deleted.changes !== 1) return json({ error: "unauthorized" }, 401);
      for (const listener of invalidationListeners) {
        try { listener(session.id); } catch { /* revocation remains authoritative */ }
      }
      const cleared = `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${publicUrl.protocol === "https:" ? "; Secure" : ""}`;
      return new Response(null, { status: 204, headers: { "cache-control": "no-store", "set-cookie": cleared } });
    }

    return json({ error: "not found" }, 404);
  }

  function sessionById(sessionId: string): RealmSession | undefined {
    if (!/^[a-f0-9]{64}$/.test(sessionId)) return undefined;
    const row = database.query<SessionRow, [string]>("SELECT expires_at FROM sessions WHERE token_hash = ?").get(sessionId);
    if (!row || row.expires_at <= now()) return undefined;
    return Object.freeze({ id: sessionId, realmId: options.realmId, expiresAt: row.expires_at });
  }

  function sessionFor(request: Request): RealmSession | undefined {
    const cookieHeader = request.headers.get("cookie");
    if (!cookieHeader) return undefined;
    let token: string | undefined;
    for (const part of cookieHeader.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;
      token = part.slice(separator + 1).trim();
      break;
    }
    if (!token || !TOKEN_PATTERN.test(token)) return undefined;
    return sessionById(tokenHash(token));
  }

  return Object.freeze({
    publicOrigin: options.publicOrigin,
    issueRegistrationUrl(issueOptions = {}) {
      const ttlMs = issueOptions.ttlMs ?? 5 * 60_000;
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_REGISTRATION_TTL_MS) throw new RangeError("registration URL lifetime is invalid");
      const token = randomToken();
      const timestamp = now();
      database.query("INSERT INTO registration_grants(token_hash, expires_at, consumed_at) VALUES (?, ?, NULL)")
        .run(tokenHash(token), timestamp + ttlMs);
      return `${options.publicOrigin}/auth/register#token=${token}`;
    },
    handle,
    sessionFor,
    sessionById,
    onSessionInvalidated(listener) {
      invalidationListeners.add(listener);
      return () => invalidationListeners.delete(listener);
    },
    close() { invalidationListeners.clear(); database.close(); },
  });
}