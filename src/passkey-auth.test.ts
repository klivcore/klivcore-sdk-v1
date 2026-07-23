import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPasskeyAuth, type PasskeyEngine, type PasskeyRegistrationResult } from "./passkey-auth";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const credential = Object.freeze({
  id: "credential-1",
  publicKey: new Uint8Array([1, 2, 3, 4]),
  counter: 0,
  transports: Object.freeze(["internal"]),
  deviceType: "multiDevice",
  backedUp: true,
});

function fakeEngine(): PasskeyEngine {
  return Object.freeze({
    async registrationOptions(input) {
      return { challenge: input.challenge, rp: { id: input.rpId, name: input.rpName }, user: { id: "dXNlcg", name: input.userName, displayName: input.userName } };
    },
    async verifyRegistration(input): Promise<PasskeyRegistrationResult> {
      return input.response === "valid-registration" ? { verified: true, credential } : { verified: false };
    },
    async authenticationOptions(input) {
      return { challenge: input.challenge, rpId: input.rpId, allowCredentials: input.credentials.map((entry) => ({ id: entry.id })) };
    },
    async verifyAuthentication(input) {
      return input.response === "valid-authentication"
        ? { verified: true, newCounter: input.credential.counter + 1, deviceType: "multiDevice", backedUp: true }
        : { verified: false };
    },
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "klivcore-passkey-auth-"));
  roots.push(root);
  const databasePath = join(root, "auth.sqlite");
  const auth = createPasskeyAuth({
    databasePath,
    realmId: "test-realm",
    realmName: "Test Realm",
    publicOrigin: "https://test-realm.trycloudflare.com",
    rpId: "test-realm.trycloudflare.com",
    engine: fakeEngine(),
    now: () => 1_000_000,
  });
  return { auth, databasePath };
}

async function post(auth: Awaited<ReturnType<typeof fixture>>["auth"], path: string, body: unknown, cookie?: string) {
  return auth.handle(new Request(`https://test-realm.trycloudflare.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://test-realm.trycloudflare.com",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  }));
}

describe("Realm passkey authentication", () => {
  test("issues a short-lived fragment-only registration capability without persisting its plaintext", async () => {
    const { auth, databasePath } = await fixture();
    const registrationUrl = auth.issueRegistrationUrl({ ttlMs: 60_000 });
    const token = new URL(registrationUrl).hash.slice("#token=".length);

    expect(registrationUrl).toMatch(/^https:\/\/test-realm\.trycloudflare\.com\/auth\/register#token=[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(Buffer.from(await readFile(databasePath)).includes(Buffer.from(token))).toBe(false);
    auth.close();
  });

  test("consumes registration and challenge exactly once and creates a Secure HttpOnly session", async () => {
    const { auth } = await fixture();
    const registrationUrl = auth.issueRegistrationUrl({ ttlMs: 60_000 });
    const token = new URL(registrationUrl).hash.slice("#token=".length);
    const options = await post(auth, "/v1/auth/register/options", { token });
    expect(options?.status).toBe(200);
    const ceremony = await options!.json() as { flowId: string; publicKey: { challenge: string } };

    const verified = await post(auth, "/v1/auth/register/verify", {
      token,
      flowId: ceremony.flowId,
      credential: "valid-registration",
    });
    expect(verified?.status).toBe(204);
    const setCookie = verified?.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__Host-kc-test-realm-session=");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Domain=");

    const replay = await post(auth, "/v1/auth/register/verify", {
      token,
      flowId: ceremony.flowId,
      credential: "valid-registration",
    });
    expect(replay?.status).toBe(401);

    const cookie = setCookie.split(";", 1)[0]!;
    const session = auth.sessionFor(new Request("https://test-realm.trycloudflare.com/", { headers: { cookie } }));
    expect(session?.realmId).toBe("test-realm");
    expect(auth.sessionById(session!.id)?.realmId).toBe("test-realm");

    const revoked: string[] = [];
    const unsubscribe = auth.onSessionInvalidated((sessionId) => revoked.push(sessionId));
    const logout = await post(auth, "/v1/auth/logout", {}, cookie);
    expect(logout?.status).toBe(204);
    expect(logout?.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(revoked).toEqual([session!.id]);
    expect(auth.sessionById(session!.id)).toBeUndefined();
    unsubscribe();
    auth.close();
  });

  test("authenticates a persisted credential and rejects foreign origins and expired grants", async () => {
    const { auth } = await fixture();
    const registrationUrl = auth.issueRegistrationUrl({ ttlMs: 60_000 });
    const token = new URL(registrationUrl).hash.slice("#token=".length);
    const registrationOptions = await (await post(auth, "/v1/auth/register/options", { token }))!.json() as { flowId: string };
    await post(auth, "/v1/auth/register/verify", { token, flowId: registrationOptions.flowId, credential: "valid-registration" });

    const foreign = await auth.handle(new Request("https://test-realm.trycloudflare.com/v1/auth/login/options", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    }));
    expect(foreign?.status).toBe(403);

    const options = await post(auth, "/v1/auth/login/options", {});
    expect(options?.status).toBe(200);
    const ceremony = await options!.json() as { flowId: string };
    const verified = await post(auth, "/v1/auth/login/verify", { flowId: ceremony.flowId, credential: "valid-authentication" });
    expect(verified?.status).toBe(204);
    expect(verified?.headers.get("set-cookie")).toContain("__Host-kc-test-realm-session=");
    auth.close();
  });
});
