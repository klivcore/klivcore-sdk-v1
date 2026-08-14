#!/usr/bin/env bun
/** One-command, secret-safe Acme browser authentication + acceptance. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Acme has one registration authority. Concurrent agents queue behind one
// lock rather than racing supported Realm-owned issuance.
if (process.env.KLIVCORE_ACME_AUTH_LOCKED !== "1") {
  const locked = Bun.spawnSync([
    "flock", "-w", "300", "/tmp/klivcore-acme-agent-auth.lock",
    "env", "KLIVCORE_ACME_AUTH_LOCKED=1", "bun", import.meta.path, ...process.argv.slice(2),
  ], { stdin: "inherit", stdout: "inherit", stderr: "inherit", timeout: 360000 });
  process.exit(locked.exitCode ?? 1);
}

const argv = process.argv.slice(2);
const value = (flag: string, fallback: string): string => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1]! : fallback;
};
const session = value("--session", `acme-auth-${Date.now()}`);
const route = value("--route", "/workbench");
const screenshot = resolve(value("--screenshot", `/tmp/${session}.png`));
const staging = argv.includes("--staging");
const doctor = argv.includes("--doctor");
const timeoutAt = Date.now() + Number(value("--timeout-ms", "180000"));
if (!/^\/[A-Za-z0-9_./-]*$/u.test(route) || route.includes("..")) throw new Error("invalid protected route");

type RunOptions = Readonly<{ cwd?: string; env?: Record<string, string>; stdin?: "ignore" | "inherit"; timeout?: number }>;
function run(command: string, args: readonly string[], options: RunOptions = {}): string {
  const child = Bun.spawnSync([command, ...args], {
    cwd: options.cwd ?? "/workspaces",
    env: { ...process.env, PATH: `/home/vscode/.local/bin:${process.env.PATH ?? ""}`, ...(options.env ?? {}) },
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeout ?? 120000,
  });
  const stdout = new TextDecoder().decode(child.stdout);
  const stderr = new TextDecoder().decode(child.stderr);
  if (child.exitCode !== 0) {
    const safe = stderr.includes("capacity") ? "registration capacity" : `${command} exited ${child.exitCode}`;
    throw new Error(safe);
  }
  return stdout;
}

function ab(...args: string[]): string {
  return run("agent-browser", ["--session", session, ...args], { timeout: 60000 });
}

type CdpMessage = Readonly<{ id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, any>; error?: Readonly<{ message: string }> }>;
type Pending = Readonly<{ resolve: (value: Record<string, any>) => void; reject: (error: Error) => void }>;
async function connect(url: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((ok, fail) => {
    socket.onopen = () => ok();
    socket.onerror = () => fail(new Error("CDP connection failed"));
  });
  let id = 0;
  const pending = new Map<number, Pending>();
  const events: CdpMessage[] = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id)!;
      pending.delete(message.id);
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result ?? {});
    } else if (message.method) events.push(message);
  };
  const call = (method: string, params?: Record<string, unknown>) => new Promise<Record<string, any>>((resolveCall, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve: resolveCall, reject });
    socket.send(JSON.stringify({ id: requestId, method, ...(params === undefined ? {} : { params }) }));
  });
  return { socket, call, events };
}

async function until<T>(fn: () => Promise<T | false>, label: string, delay = 100): Promise<T> {
  while (Date.now() < timeoutAt) {
    const result = await fn();
    if (result) return result;
    await Bun.sleep(delay);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function safeFailure(error: unknown): string {
  const text = String(error instanceof Error ? error.message : error);
  if (/capacity/iu.test(text)) return "registration-capacity";
  if (/target/iu.test(text)) return "browser-target";
  if (/credential/iu.test(text)) return "credential-ceremony";
  if (/timeout/iu.test(text)) return "timeout";
  if (/CDP/iu.test(text)) return "browser-cdp";
  if (/route|mount/iu.test(text)) return "protected-route";
  return "authentication-workflow";
}

let cdp: Awaited<ReturnType<typeof connect>> | undefined;
let authenticatorId: string | undefined;
let stage = "preflight";
try {
  run("agent-browser", ["--version"], { timeout: 30000 });
  if (doctor) {
    ab("open", "about:blank");
    const cdpUrl = ab("get", "cdp-url").trim();
    if (!/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//u.test(cdpUrl)) throw new Error("CDP endpoint unavailable");
    ab("close");
    console.log(JSON.stringify({ status: "PASS", mode: "doctor", executionProfile: "acme", session, cdp: true }));
    process.exit(0);
  }

  stage = "issuance";
  const packageSpec = staging
    ? "https://github.com/klivcore/klivcore-sdk-v1.git#staging"
    : "https://github.com/klivcore/klivcore-sdk-v1.git";
  const channelArgs = staging ? ["--staging"] : [];
  const issued = Bun.spawnSync([
    "bunx", packageSpec, "start-realm", ...channelArgs, "registration-url", "acme",
  ], { cwd: "/workspaces", stdout: "pipe", stderr: "pipe", timeout: 300000 });
  if (issued.exitCode !== 0) throw new Error("Acme supported registration issuance failed");
  const issuance = (new TextDecoder().decode(issued.stdout) + "\n" + new TextDecoder().decode(issued.stderr))
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
  const urls = [...new Set([...issuance.matchAll(/https:\/\/[^\s'"<>]+/gu)]
    .map((match) => match[0].replace(/[),.;]+$/u, ""))
    .filter((candidate) => {
      try {
        const parsed = new URL(candidate);
        return parsed.pathname === "/auth/register" && /^#token=[A-Za-z0-9_-]+$/u.test(parsed.hash);
      } catch { return false; }
    }))];
  if (urls.length !== 1) throw new Error("registration URL issuance did not return exactly one capability");
  const registrationUrl = new URL(urls[0]!);
  const origin = registrationUrl.origin;

  stage = "browser-open";
  ab("open", `${origin}/auth/login`);
  ab("open", registrationUrl.href);
  const browserCdpUrl = ab("get", "cdp-url").trim();
  const port = new URL(browserCdpUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<Record<string, any>>;
  const target = targets.find((entry) => entry.type === "page"
    && new URL(entry.url).origin === origin
    && /register passkey/iu.test(entry.title ?? ""));
  if (!target?.webSocketDebuggerUrl) throw new Error("registration page target unavailable");
  cdp = await connect(target.webSocketDebuggerUrl);
  stage = "authenticator-attach";
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Log.enable");
  await cdp.call("WebAuthn.enable", { enableUI: false });
  ({ authenticatorId } = await cdp.call("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal",
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  }));
  await cdp.call("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: true });
  await cdp.call("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });

  stage = "registration";
  await until(async () => (await cdp!.call("Runtime.evaluate", { expression: "document.readyState", returnByValue: true })).result.value !== "loading", "registration document");
  cdp.events.length = 0;
  const clicked = await cdp.call("Runtime.evaluate", {
    expression: `(()=>{const buttons=[...document.querySelectorAll('button')];const button=buttons.find(b=>/register passkey/i.test(b.textContent||''))||buttons[0];if(!button)return false;button.click();return true})()`,
    returnByValue: true,
  });
  if (!clicked.result.value) throw new Error("registration control unavailable");

  await until(async () => {
    const added = cdp!.events.some((event) => event.method === "WebAuthn.credentialAdded");
    const document = (await cdp!.call("Runtime.evaluate", {
      expression: "({ href: location.href, registrationDocument: /register passkey/iu.test(document.title) })",
      returnByValue: true,
    })).result.value;
    return added && !document.registrationDocument ? document.href as string : false;
  }, "credential commit and authenticated redirect");

  const protectedUrl = `${origin}${route}`;
  stage = "protected-route";
  cdp.events.length = 0;
  await cdp.call("Page.navigate", { url: protectedUrl });
  const mounted = await until(async () => {
    const result = await cdp!.call("Runtime.evaluate", {
      expression: `(()=>{const walk=(root)=>{if(root.querySelector?.('[data-workbench-element-id]'))return true;for(const el of root.querySelectorAll?.('*')||[])if(el.shadowRoot&&walk(el.shadowRoot))return true;return false};return {href:location.href,mounted:walk(document),title:document.title}})()`,
      returnByValue: true,
    });
    const state = result.result.value as Readonly<{ href: string; mounted: boolean; title: string }>;
    return state.href === protectedUrl && state.mounted ? state : false;
  }, "protected Workbench mount", 200);

  mkdirSync(dirname(screenshot), { recursive: true });
  const shot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(screenshot, Buffer.from(shot.data, "base64"), { mode: 0o600 });
  const consoleErrors = cdp.events.filter((event) => event.method === "Runtime.exceptionThrown"
    || (event.method === "Log.entryAdded" && ["error", "warning"].includes(String((event.params?.entry as Record<string, unknown> | undefined)?.level)))).length;
  console.log(JSON.stringify({
    status: "PASS", executionProfile: "acme", session, channel: staging ? "staging" : "production",
    origin, route, finalUrl: mounted.href, title: mounted.title,
    credentialAdded: true, authenticatedRedirect: true, workbenchMounted: true,
    consoleOrPageErrors: consoleErrors, screenshot,
  }));
} catch (error) {
  console.log(JSON.stringify({ status: "FAIL", stage, reason: safeFailure(error), session }));
  process.exitCode = 1;
} finally {
  if (cdp && authenticatorId) {
    try { await cdp.call("WebAuthn.removeVirtualAuthenticator", { authenticatorId }); } catch {}
  }
  try { cdp?.socket.close(); } catch {}
  try { ab("close"); } catch {}
}
