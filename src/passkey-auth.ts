import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
const AGENT_SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const AGENT_PAIRING_TTL_MS = 5 * 60_000;
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
  | Readonly<{ verified: false; reason?: PasskeyVerificationFailure }>
  | Readonly<{ verified: true; credential: StoredCredential }>;

export type PasskeyVerificationFailure = "credential-id" | "credential-type" | "challenge" | "origin" | "rp-id"
  | "user-presence" | "user-verification" | "attestation" | "malformed-response";

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

export type RealmBranding = Readonly<{ canvasColor: string }>;

export function parseRealmBranding(value: RealmBranding): RealmBranding {
  if (!value || Object.keys(value).join(",") !== "canvasColor" || !/^#[0-9a-f]{6}$/.test(value.canvasColor)) {
    throw new TypeError("Realm branding is invalid");
  }
  return Object.freeze({ canvasColor: value.canvasColor });
}

export type PasskeyAuthOptions = Readonly<{
  branding: RealmBranding;
  databasePath: string;
  realmId: string;
  realmName: string;
  publicOrigin: string;
  rpId: string;
  engine?: PasskeyEngine;
  now?: () => number;
  allowInsecureLoopback?: boolean;
  agentAccess?: Readonly<{ capabilities: readonly string[] }>;
  registrationControlToken?: string;
}>;

export type RealmSession = Readonly<{
  id: string;
  realmId: string;
  expiresAt: number;
  principal?: "human" | "agent";
  capabilities?: readonly string[];
}>;

export type PasskeyAuth = Readonly<{
  publicOrigin: string;
  issueRegistrationUrl(options?: Readonly<{ ttlMs?: number }>): string;
  handle(request: Request): Promise<Response | undefined>;
  sessionFor(request: Request): RealmSession | undefined;
  sessionById(sessionId: string): RealmSession | undefined;
  onSessionInvalidated(listener: (sessionId: string) => void): () => void;
  close(): void;
}>;

type GrantRow = { token_hash: string; user_id: Uint8Array; expires_at: number; consumed_at: number | null };
type CeremonyRow = { id: string; kind: string; token_hash: string | null; challenge: string; expires_at: number; consumed_at: number | null };
type CredentialRow = { id: string; public_key: Uint8Array; counter: number; transports_json: string; device_type: string; backed_up: number };
type SessionRow = { expires_at: number; principal: string; capabilities_json: string | null };
type AgentPairingRow = { id: string; expires_at: number; approved_at: number | null; consumed_at: number | null };

export function approveAgentPairing(input: Readonly<{ databasePath: string; pairingId: string; now?: number }>): boolean {
  if (!/^[a-f0-9-]{36}$/.test(input.pairingId)) return false;
  const database = new Database(resolve(input.databasePath), { create: false, strict: true });
  try {
    const timestamp = input.now ?? Date.now();
    const result = database.query("UPDATE agent_pairings SET approved_at = ? WHERE id = ? AND approved_at IS NULL AND consumed_at IS NULL AND expires_at > ?")
      .run(timestamp, input.pairingId, timestamp);
    return result.changes === 1;
  } finally {
    database.close();
  }
}

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
      challenge: Uint8Array.from(Buffer.from(input.challenge, "base64url")),
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const reason: PasskeyVerificationFailure = /credential ID|base64url-encoded/i.test(message) ? "credential-id"
        : /credential type|registration response type/i.test(message) ? "credential-type"
          : /challenge/i.test(message) ? "challenge"
            : /origin/i.test(message) ? "origin"
              : /RP ID/i.test(message) ? "rp-id"
                : /user presence/i.test(message) ? "user-presence"
                  : /user verification|user could not be verified/i.test(message) ? "user-verification"
                    : /attestation|AAGUID|public key|authenticator data/i.test(message) ? "attestation"
                      : "malformed-response";
      return Object.freeze({ verified: false, reason });
    }
  },
  async authenticationOptions(input) {
    return generateAuthenticationOptions({
      rpID: input.rpId,
      challenge: Uint8Array.from(Buffer.from(input.challenge, "base64url")),
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

function authPage(kind: "register" | "login", realmName: string, branding: RealmBranding): Response {
  const action = kind === "register" ? "Register passkey" : "Sign in with passkey";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="${branding.canvasColor}"><title>${action} · ${realmName}</title><style>
:root{color-scheme:light;--realm-ink:#14202b;--realm-muted:#667381;--realm-line:#d9e0e6;--realm-surface:#fff;--realm-canvas:${branding.canvasColor};--realm-canvas-ink:#e9edf3;--realm-canvas-muted:#8f99a8;--realm-canvas-line:#232833;--realm-accent:#137a92;--realm-accent-hover:#0d6074;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{min-height:100%;margin:0}body{background:var(--realm-canvas);color:var(--realm-canvas-ink);-webkit-font-smoothing:antialiased}.auth-shell{min-height:100vh;display:grid;grid-template-rows:auto 1fr auto}.auth-header,.auth-footer{display:flex;align-items:center;justify-content:space-between;padding:24px clamp(24px,5vw,72px);font-size:12px;letter-spacing:.14em;text-transform:uppercase}.auth-header{border-bottom:1px solid var(--realm-canvas-line);font-weight:700}.auth-header span:last-child,.auth-footer{color:var(--realm-canvas-muted)}.auth-main{display:grid;place-items:center;padding:48px 24px}.auth-card{width:min(100%,520px);padding:clamp(32px,6vw,56px);background:var(--realm-surface);color:var(--realm-ink);border:1px solid var(--realm-line);border-radius:20px;box-shadow:0 24px 70px rgba(20,32,43,.09)}.auth-eyebrow{margin:0 0 18px;color:var(--realm-accent);font-size:12px;font-weight:750;letter-spacing:.14em;text-transform:uppercase}.auth-card h1{margin:0;font-size:clamp(34px,7vw,54px);font-weight:540;letter-spacing:-.045em;line-height:1.02}.auth-copy{margin:20px 0 32px;color:var(--realm-muted);font-size:16px;line-height:1.65}.auth-action{width:100%;min-height:52px;border:0;border-radius:12px;padding:14px 20px;background:var(--realm-accent);color:#fff;font:inherit;font-weight:700;cursor:pointer;transition:background-color .16s ease,transform .16s ease}.auth-action:hover{background:var(--realm-accent-hover)}.auth-action:active{transform:translateY(1px)}.auth-action:disabled{cursor:wait;opacity:.65}.auth-action:focus-visible,.auth-log summary:focus-visible,.auth-log-copy:focus-visible{outline:3px solid rgba(19,122,146,.28);outline-offset:3px}.auth-status{min-height:24px;margin:18px 0 0;color:#a13b35;font-size:14px;line-height:1.5}.auth-log{margin-top:8px;border-top:1px solid var(--realm-line);padding-top:18px}.auth-log summary{color:var(--realm-accent);cursor:pointer;font-size:14px;font-weight:700}.auth-log-body{margin-top:14px}.auth-log-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}.auth-log-note{margin:0;color:var(--realm-muted);font-size:12px;line-height:1.4}.auth-log-copy{border:1px solid var(--realm-line);border-radius:8px;padding:7px 11px;background:var(--realm-surface);color:var(--realm-ink);font:inherit;font-size:12px;font-weight:700;cursor:pointer}.auth-log-copy:hover{background:var(--realm-canvas)}.auth-log-output{max-height:240px;margin:0;overflow:auto;border:1px solid var(--realm-line);border-radius:10px;padding:12px;background:#101820;color:#d9e5ec;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word}.auth-footer{border-top:1px solid var(--realm-canvas-line);letter-spacing:0;text-transform:none}@media(max-width:540px){.auth-header{align-items:flex-start;gap:8px;flex-direction:column}.auth-card{border-radius:16px}.auth-footer{align-items:flex-start;gap:6px;flex-direction:column}.auth-log-toolbar{align-items:flex-start;flex-direction:column}}@media(prefers-reduced-motion:reduce){.auth-action{transition:none}}
</style></head><body data-passkey-page="${kind}"><div class="auth-shell"><header class="auth-header"><span>Klivcore Realm</span><span>Identity authority</span></header><main class="auth-main"><section class="auth-card" aria-labelledby="realm-title"><p class="auth-eyebrow">Secure Realm access</p><h1 id="realm-title">${realmName}</h1><p class="auth-copy">Use a passkey to continue to this Realm. Authentication is scoped to this exact Realm origin.</p><button class="auth-action" type="button" id="passkey-action">${action}</button><p class="auth-status" id="status" role="status" aria-live="polite"></p><details class="auth-log" id="auth-log-panel"><summary>Full auth log</summary><div class="auth-log-body"><div class="auth-log-toolbar"><p class="auth-log-note">Safe diagnostics only. Secrets and credential data are excluded.</p><button class="auth-log-copy" type="button" id="copy-auth-log">Copy log</button></div><pre class="auth-log-output" id="auth-log-output" aria-live="polite"></pre></div></details></section></main><footer class="auth-footer"><span>Private by default</span><span>Passkey-protected access</span></footer></div><script src="/auth/passkey.js" defer></script></body></html>`;
  return new Response(html, { headers: { ...authHeaders(), "content-type": "text/html; charset=utf-8" } });
}

function agentPairingPage(pairingId: string, realmName: string, branding: RealmBranding): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="${branding.canvasColor}"><title>Pair agent · ${realmName}</title><style>
:root{color-scheme:light;--canvas:${branding.canvasColor};font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}html,body{min-height:100%;margin:0}body{display:grid;place-items:center;padding:24px;background:var(--canvas);color:#14202b}.card{width:min(100%,520px);padding:44px;background:#fff;border:1px solid #d9e0e6;border-radius:20px;box-shadow:0 24px 70px rgba(0,0,0,.2)}.eyebrow{margin:0 0 16px;color:#137a92;font-size:12px;font-weight:750;letter-spacing:.14em;text-transform:uppercase}h1{margin:0;font-size:38px;letter-spacing:-.035em}.copy{margin:18px 0;color:#667381;line-height:1.6}.pairing{padding:14px;border-radius:10px;background:#f2f5f7;font:600 13px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.status{margin:20px 0 0;color:#137a92;font-weight:700}
</style></head><body data-agent-pairing-id="${pairingId}"><main class="card"><p class="eyebrow">Scoped agent access</p><h1>${realmName}</h1><p class="copy">Waiting for local DevPod approval. This pairing grants only the capabilities configured by this Realm and contains no browser bearer credential.</p><div class="pairing">${pairingId}</div><p class="status" id="status" role="status" aria-live="polite">Pending approval…</p></main><script src="/auth/agent-pair.js" defer></script></body></html>`;
  return new Response(html, { headers: { ...authHeaders(), "content-type": "text/html; charset=utf-8" } });
}

const AGENT_PAIRING_BROWSER_JS = String.raw`(() => {
  const status = document.querySelector('#status');
  let stopped = false;
  async function poll() {
    if (stopped) return;
    try {
      const response = await fetch('/v1/auth/agent/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (response.status === 204) { stopped = true; status.textContent = 'Approved. Opening Realm…'; location.replace('/debug/resource-monitor'); return; }
      if (response.status !== 202) { stopped = true; status.textContent = 'Pairing expired or unavailable.'; return; }
    } catch { status.textContent = 'Realm unavailable. Retrying…'; }
    setTimeout(poll, 1000);
  }
  poll();
})();`;

const PASSKEY_BROWSER_JS = String.raw`(() => {
  const body = document.body;
  const button = document.querySelector('#passkey-action');
  const status = document.querySelector('#status');
  const logPanel = document.querySelector('#auth-log-panel');
  const logOutput = document.querySelector('#auth-log-output');
  const copyLog = document.querySelector('#copy-auth-log');
  const startedAt = performance.now();
  const entries = [];
  const safeReasons = new Set(['credential-id', 'credential-type', 'challenge', 'origin', 'rp-id', 'user-presence', 'user-verification', 'attestation', 'malformed-response']);
  const clean = (value) => String(value).replace(/[^A-Za-z0-9 ._:/=+-]/g, '?').slice(0, 180);
  const log = (event, detail = '') => { const elapsed = String(Math.round(performance.now() - startedAt)).padStart(5, '0'); const line = '[+' + elapsed + 'ms] ' + clean(event) + (detail ? ' ' + clean(detail) : ''); entries.push(line); if (entries.length > 200) entries.shift(); logOutput.textContent = entries.join('\n'); logOutput.scrollTop = logOutput.scrollHeight; };
  const safeError = (error) => error instanceof DOMException ? error.name : error instanceof Error && (/^Request failed \([0-9]{3}\)(: [a-z-]+)?$/.test(error.message) || error.message === 'Registration capability is missing' || /was cancelled$/.test(error.message)) ? error.message : 'UnexpectedError';
  const pageKind = body.dataset.passkeyPage === 'register' ? 'register' : 'login';
  const registrationToken = pageKind === 'register' ? new URL(location.href).hash.slice('#token='.length) : '';
  if (pageKind === 'register') history.replaceState(null, '', '/auth/register');
  log('page.loaded', 'kind=' + pageKind + ' origin=' + location.origin + ' webauthn=' + ('PublicKeyCredential' in window));
  if (pageKind === 'register') log('registration.capability present=' + Boolean(registrationToken));
  copyLog.addEventListener('click', async () => { try { await navigator.clipboard.writeText(entries.join('\n')); copyLog.textContent = 'Copied'; setTimeout(() => { copyLog.textContent = 'Copy log'; }, 1600); } catch { copyLog.textContent = 'Copy unavailable'; } });
  const b64 = (value) => { const input = value.replace(/-/g, '+').replace(/_/g, '/'); const raw = atob(input + '='.repeat((4 - input.length % 4) % 4)); return Uint8Array.from(raw, c => c.charCodeAt(0)); };
  const enc = (value) => { const bytes = new Uint8Array(value); let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte); return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); };
  const creation = (value) => PublicKeyCredential.parseCreationOptionsFromJSON ? PublicKeyCredential.parseCreationOptionsFromJSON(value) : { ...value, challenge: b64(value.challenge), user: { ...value.user, id: b64(value.user.id) }, excludeCredentials: (value.excludeCredentials || []).map(x => ({ ...x, id: b64(x.id) })) };
  const request = (value) => PublicKeyCredential.parseRequestOptionsFromJSON ? PublicKeyCredential.parseRequestOptionsFromJSON(value) : { ...value, challenge: b64(value.challenge), allowCredentials: (value.allowCredentials || []).map(x => ({ ...x, id: b64(x.id) })) };
  const serialize = (credential) => ({ id: credential.id, rawId: enc(credential.rawId), type: credential.type, authenticatorAttachment: credential.authenticatorAttachment, clientExtensionResults: credential.getClientExtensionResults(), response: credential.response.attestationObject ? { clientDataJSON: enc(credential.response.clientDataJSON), attestationObject: enc(credential.response.attestationObject), transports: credential.response.getTransports ? credential.response.getTransports() : [] } : { clientDataJSON: enc(credential.response.clientDataJSON), authenticatorData: enc(credential.response.authenticatorData), signature: enc(credential.response.signature), userHandle: credential.response.userHandle ? enc(credential.response.userHandle) : undefined } });
  async function post(path, value) { const requestAt = performance.now(); log('request.start', 'path=' + path); const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }); const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined); const reason = payload && safeReasons.has(payload.reason) ? payload.reason : ''; log('request.end', 'path=' + path + ' status=' + response.status + ' duration_ms=' + Math.round(performance.now() - requestAt) + (reason ? ' reason=' + reason : '')); if (!response.ok) throw new Error('Request failed (' + response.status + ')' + (reason ? ': ' + reason : '')); return payload; }
  button.addEventListener('click', async () => {
    button.disabled = true; status.textContent = 'Waiting for your authenticator…';
    log('flow.start', 'kind=' + pageKind);
    try {
      if (pageKind === 'register') {
        if (!registrationToken) throw new Error('Registration capability is missing');
        const flow = await post('/v1/auth/register/options', { token: registrationToken });
        log('webauthn.create.start');
        const credential = await navigator.credentials.create({ publicKey: creation(flow.publicKey) });
        if (!credential) throw new Error('Passkey registration was cancelled');
        log('webauthn.create.end', 'result=credential-created');
        await post('/v1/auth/register/verify', { token: registrationToken, flowId: flow.flowId, credential: serialize(credential) });
      } else {
        const flow = await post('/v1/auth/login/options', {});
        log('webauthn.get.start');
        const credential = await navigator.credentials.get({ publicKey: request(flow.publicKey) });
        if (!credential) throw new Error('Passkey authentication was cancelled');
        log('webauthn.get.end', 'result=credential-received');
        await post('/v1/auth/login/verify', { flowId: flow.flowId, credential: serialize(credential) });
      }
      log('flow.complete', 'redirect=/');
      location.replace('/');
    } catch (error) { const category = safeError(error); log('flow.failed', 'category=' + category); status.textContent = category; logPanel.open = true; button.disabled = false; }
  });
})();`;

export function createPasskeyAuth(options: PasskeyAuthOptions): PasskeyAuth {
  const now = options.now ?? Date.now;
  const branding = parseRealmBranding(options.branding);
  const agentCapabilities = options.agentAccess
    ? Object.freeze([...new Set(options.agentAccess.capabilities)])
    : undefined;
  if (agentCapabilities && (agentCapabilities.length < 1 || agentCapabilities.length > 32
    || agentCapabilities.some((capability) => !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(capability)))) {
    throw new TypeError("agent access capabilities are invalid");
  }
  if (options.registrationControlToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(options.registrationControlToken)) {
    throw new TypeError("registration control token is invalid");
  }
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
  const realmUserId = createHash("sha256").update(`klivcore-realm-user\0${options.realmId}`).digest();
  database.exec(`
    CREATE TABLE IF NOT EXISTS registration_grants (
      token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
      user_id BLOB NOT NULL CHECK(length(user_id) = 32),
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
      user_id BLOB NOT NULL CHECK(length(user_id) = 32),
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
      created_at INTEGER NOT NULL,
      principal TEXT NOT NULL DEFAULT 'human' CHECK(principal IN ('human', 'agent')),
      capabilities_json TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_pairings (
      id TEXT PRIMARY KEY,
      verifier_hash TEXT NOT NULL UNIQUE CHECK(length(verifier_hash) = 64),
      expires_at INTEGER NOT NULL,
      approved_at INTEGER,
      consumed_at INTEGER
    ) STRICT;
  `);
  const grantColumns = new Set(database.query<{ name: string }, []>("PRAGMA table_info(registration_grants)").all().map((column) => column.name));
  if (!grantColumns.has("user_id")) database.exec("DELETE FROM registration_grants; ALTER TABLE registration_grants ADD COLUMN user_id BLOB");
  const credentialColumns = new Set(database.query<{ name: string }, []>("PRAGMA table_info(credentials)").all().map((column) => column.name));
  if (!credentialColumns.has("user_id")) {
    database.exec("ALTER TABLE credentials ADD COLUMN user_id BLOB");
    database.query("UPDATE credentials SET user_id = ? WHERE user_id IS NULL").run(realmUserId);
  }
  const sessionColumns = new Set(database.query<{ name: string }, []>("PRAGMA table_info(sessions)").all().map((column) => column.name));
  if (!sessionColumns.has("principal")) database.exec("ALTER TABLE sessions ADD COLUMN principal TEXT NOT NULL DEFAULT 'human' CHECK(principal IN ('human', 'agent'))");
  if (!sessionColumns.has("capabilities_json")) database.exec("ALTER TABLE sessions ADD COLUMN capabilities_json TEXT");
  const engine = options.engine ?? defaultEngine;
  const invalidationListeners = new Set<(sessionId: string) => void>();
  const cookieName = publicUrl.protocol === "https:"
    ? `__Host-kc-${options.realmId}-session`
    : `kc-${options.realmId}-session`;
  const pairingCookieName = publicUrl.protocol === "https:"
    ? `__Host-kc-${options.realmId}-agent-pairing`
    : `kc-${options.realmId}-agent-pairing`;
  const cookie = (token: string, ttlMs = SESSION_TTL_MS) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}${publicUrl.protocol === "https:" ? "; Secure" : ""}`;
  const pairingCookie = (token: string) => `${pairingCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(AGENT_PAIRING_TTL_MS / 1000)}${publicUrl.protocol === "https:" ? "; Secure" : ""}`;

  const allCredentials = () => database.query<CredentialRow, []>("SELECT id, public_key, counter, transports_json, device_type, backed_up FROM credentials ORDER BY id LIMIT 32").all().map(storedCredential);
  const createSession = (principal: "human" | "agent" = "human", capabilities?: readonly string[]) => {
    const token = randomToken();
    const createdAt = now();
    const ttlMs = principal === "agent" ? AGENT_SESSION_TTL_MS : SESSION_TTL_MS;
    database.query("INSERT INTO sessions(token_hash, expires_at, created_at, principal, capabilities_json) VALUES (?, ?, ?, ?, ?)")
      .run(tokenHash(token), createdAt + ttlMs, createdAt, principal, capabilities ? JSON.stringify(capabilities) : null);
    return token;
  };
  const cookieValue = (request: Request, name: string) => {
    const cookieHeader = request.headers.get("cookie");
    if (!cookieHeader) return undefined;
    for (const part of cookieHeader.split(";")) {
      const separator = part.indexOf("=");
      if (separator >= 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
    }
    return undefined;
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

  function issueRegistrationUrl(issueOptions: Readonly<{ ttlMs?: number }> = {}): string {
    const ttlMs = issueOptions.ttlMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_REGISTRATION_TTL_MS) throw new RangeError("registration URL lifetime is invalid");
    const token = randomToken();
    const timestamp = now();
    const reserve = database.transaction(() => {
      database.query("DELETE FROM registration_grants WHERE expires_at <= ?").run(timestamp);
      const capacity = database.query<{ count: number }, []>("SELECT (SELECT count(*) FROM credentials) + (SELECT count(*) FROM registration_grants) AS count").get()?.count ?? 0;
      if (capacity >= 32) throw new Error("registration URL limit reached");
      database.query("INSERT INTO registration_grants(token_hash, user_id, expires_at, consumed_at) VALUES (?, ?, ?, NULL)")
        .run(tokenHash(token), randomBytes(32), timestamp + ttlMs);
    });
    reserve.immediate();
    return `${options.publicOrigin}/auth/register#token=${token}`;
  }

  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/auth/register") return authPage("register", options.realmName, branding);
    if (request.method === "GET" && url.pathname === "/auth/login") return authPage("login", options.realmName, branding);
    if (request.method === "GET" && url.pathname === "/auth/agent") {
      if (!agentCapabilities) return json({ error: "not found" }, 404);
      const timestamp = now();
      database.query("DELETE FROM agent_pairings WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(timestamp);
      const existingSecret = cookieValue(request, pairingCookieName);
      const existing = existingSecret && TOKEN_PATTERN.test(existingSecret)
        ? database.query<AgentPairingRow, [string, number]>("SELECT id, expires_at, approved_at, consumed_at FROM agent_pairings WHERE verifier_hash = ? AND expires_at > ? AND consumed_at IS NULL")
          .get(tokenHash(existingSecret), timestamp)
        : undefined;
      if (existing) return agentPairingPage(existing.id, options.realmName, branding);
      const active = database.query<{ count: number }, []>("SELECT count(*) AS count FROM agent_pairings").get()?.count ?? 0;
      if (active >= 8) return json({ error: "agent pairing unavailable" }, 429);
      const pairingId = randomUUID();
      const secret = randomToken();
      database.query("INSERT INTO agent_pairings(id, verifier_hash, expires_at, approved_at, consumed_at) VALUES (?, ?, ?, NULL, NULL)")
        .run(pairingId, tokenHash(secret), timestamp + AGENT_PAIRING_TTL_MS);
      const response = agentPairingPage(pairingId, options.realmName, branding);
      response.headers.set("set-cookie", pairingCookie(secret));
      return response;
    }
    if (request.method === "GET" && url.pathname === "/auth/passkey.js") {
      return new Response(PASSKEY_BROWSER_JS, { headers: { ...authHeaders(), "content-type": "text/javascript; charset=utf-8" } });
    }
    if (request.method === "GET" && url.pathname === "/auth/agent-pair.js" && agentCapabilities) {
      return new Response(AGENT_PAIRING_BROWSER_JS, { headers: { ...authHeaders(), "content-type": "text/javascript; charset=utf-8" } });
    }
    if (!url.pathname.startsWith("/v1/auth/")) return undefined;
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!exactOrigin(request)) return json({ error: "forbidden" }, 403);
    const body = await boundedJson(request);
    if (!body) return json({ error: "invalid request" }, 400);
    const timestamp = now();

    if (url.pathname === "/v1/auth/runtime/registration-url") {
      if (!options.registrationControlToken || !exactKeys(body, [])) return json({ error: "not found" }, 404);
      const authorization = request.headers.get("authorization");
      const candidate = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
      if (!candidate || !/^[A-Za-z0-9_-]{43}$/.test(candidate)
        || !timingSafeEqual(Buffer.from(candidate), Buffer.from(options.registrationControlToken))) {
        return json({ error: "unauthorized" }, 401);
      }
      return json({ registrationUrl: issueRegistrationUrl() }, 201);
    }

    if (url.pathname === "/v1/auth/agent/status") {
      if (!agentCapabilities || !exactKeys(body, [])) return json({ error: "not found" }, 404);
      const secret = cookieValue(request, pairingCookieName);
      if (!secret || !TOKEN_PATTERN.test(secret)) return json({ error: "unauthorized" }, 401);
      const verifierHash = tokenHash(secret);
      const pairing = database.query<AgentPairingRow, [string, number]>("SELECT id, expires_at, approved_at, consumed_at FROM agent_pairings WHERE verifier_hash = ? AND expires_at > ? AND consumed_at IS NULL")
        .get(verifierHash, timestamp);
      if (!pairing) return json({ error: "unauthorized" }, 401);
      if (pairing.approved_at === null) return json({ status: "pending" }, 202);
      const issueAgentSession = database.transaction(() => {
        const consumed = database.query("UPDATE agent_pairings SET consumed_at = ? WHERE id = ? AND approved_at IS NOT NULL AND consumed_at IS NULL AND expires_at > ?")
          .run(timestamp, pairing.id, timestamp);
        return consumed.changes === 1 ? createSession("agent", agentCapabilities) : undefined;
      });
      const sessionToken = issueAgentSession();
      if (!sessionToken) return json({ error: "unauthorized" }, 401);
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "no-store", "set-cookie": cookie(sessionToken, AGENT_SESSION_TTL_MS) },
      });
    }

    if (url.pathname === "/v1/auth/register/options") {
      if (!exactKeys(body, ["token"]) || typeof body.token !== "string" || !TOKEN_PATTERN.test(body.token)) return json({ error: "invalid request" }, 400);
      const hash = tokenHash(body.token);
      database.query("DELETE FROM registration_grants WHERE expires_at <= ?").run(timestamp);
      const grant = database.query<GrantRow, [string]>("SELECT token_hash, user_id, expires_at, consumed_at FROM registration_grants WHERE token_hash = ?").get(hash);
      if (!grant || grant.consumed_at !== null || grant.expires_at <= timestamp) return json({ error: "unauthorized" }, 401);
      const challenge = randomToken();
      const flowId = randomToken(18);
      const publicKey = await engine.registrationOptions({
        challenge,
        rpId: options.rpId,
        rpName: options.realmName,
        userId: grant.user_id,
        userName: `${options.realmId} user`,
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
      const flowId = body.flowId;
      const ceremony = claimCeremony(flowId, "register", hash);
      if (!ceremony) return json({ error: "unauthorized" }, 401);
      const result = await engine.verifyRegistration({ challenge: ceremony.challenge, expectedOrigin: options.publicOrigin, rpId: options.rpId, response: body.credential });
      if (!result.verified) return json({ error: "unauthorized", reason: result.reason ?? "malformed-response" }, 401);
      let sessionToken: string | undefined;
      const commit = database.transaction(() => {
        const credentialCount = database.query<{ count: number }, []>("SELECT count(*) AS count FROM credentials").get()?.count ?? 0;
        if (credentialCount >= 32) return;
        const grant = database.query<Pick<GrantRow, "user_id">, [string, number]>("SELECT user_id FROM registration_grants WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?").get(hash, timestamp);
        if (!grant) return;
        const consumed = database.query("DELETE FROM registration_grants WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?")
          .run(hash, timestamp);
        if (consumed.changes !== 1) return;
        const removedCeremony = database.query("DELETE FROM ceremonies WHERE id = ? AND kind = 'register' AND token_hash = ?")
          .run(flowId, hash);
        if (removedCeremony.changes !== 1) throw new Error("registration ceremony was not removed");
        const entry = result.credential;
        database.query("INSERT INTO credentials(id, user_id, public_key, counter, transports_json, device_type, backed_up, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(entry.id, grant.user_id, entry.publicKey, entry.counter, JSON.stringify(entry.transports), entry.deviceType, entry.backedUp ? 1 : 0, timestamp, timestamp);
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
    const row = database.query<SessionRow, [string]>("SELECT expires_at, principal, capabilities_json FROM sessions WHERE token_hash = ?").get(sessionId);
    if (!row || row.expires_at <= now()) return undefined;
    if (row.principal === "agent") {
      let capabilities: unknown;
      try { capabilities = row.capabilities_json ? JSON.parse(row.capabilities_json) : undefined; } catch { return undefined; }
      if (!Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== "string")) return undefined;
      return Object.freeze({
        id: sessionId,
        realmId: options.realmId,
        expiresAt: row.expires_at,
        principal: "agent" as const,
        capabilities: Object.freeze([...capabilities]),
      });
    }
    if (row.principal !== "human") return undefined;
    return Object.freeze({ id: sessionId, realmId: options.realmId, expiresAt: row.expires_at, principal: "human" as const });
  }

  function sessionFor(request: Request): RealmSession | undefined {
    const token = cookieValue(request, cookieName);
    if (!token || !TOKEN_PATTERN.test(token)) return undefined;
    return sessionById(tokenHash(token));
  }

  return Object.freeze({
    publicOrigin: options.publicOrigin,
    issueRegistrationUrl,
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