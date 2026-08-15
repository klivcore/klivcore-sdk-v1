import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const WORKBENCH_MOUNT_SELECTOR = '[data-workbench-canvas="true"]';

export function browserSafeStateExpression(expectedUrl: string): string {
  const url = new URL(expectedUrl);
  if (url.protocol !== "https:" || url.hash) throw new TypeError("expected browser URL is invalid");
  return `(()=>{const has=(selector,root=document)=>{if(root.querySelector?.(selector))return true;for(const el of root.querySelectorAll?.('*')||[])if(el.shadowRoot&&has(selector,el.shadowRoot))return true;return false};const readyState=['loading','interactive','complete'].includes(document.readyState)?document.readyState:'unknown';return {routeMatches:location.href===${JSON.stringify(url.href)},titlePresent:document.title.length>0,readyState,canvasPresent:has(${JSON.stringify(WORKBENCH_MOUNT_SELECTOR)}),elementPresent:has('[data-workbench-element-id]')}})()`;
}

export function writePrivateScreenshot(path: string, bytes: Uint8Array): void {
  const stage = join(dirname(path), `.${basename(path)}.stage-${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, bytes);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(stage, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(stage); } catch { /* renamed or never created */ }
  }
}

export function browserWaitDeadline(timeoutMs: number, now = Date.now()): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw new RangeError("browser timeout is invalid");
  }
  return now + timeoutMs;
}

export function withBrowserDeadline<T>(operation: Promise<T>, deadline: number, label: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (!Number.isFinite(deadline) || remaining <= 0) {
    return Promise.reject(new Error(`timeout waiting for ${label}`));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), remaining);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function browserDiagnosticCounts(events: readonly unknown[]): Readonly<{
  exceptions: number;
  logErrors: number;
  logWarnings: number;
}> {
  let exceptions = 0;
  let logErrors = 0;
  let logWarnings = 0;
  for (const value of events) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    if (event.method === "Runtime.exceptionThrown") {
      exceptions += 1;
      continue;
    }
    if (event.method !== "Log.entryAdded" || !event.params || typeof event.params !== "object" || Array.isArray(event.params)) continue;
    const entry = (event.params as Record<string, unknown>).entry;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const level = (entry as Record<string, unknown>).level;
    if (level === "error") logErrors += 1;
    if (level === "warning") logWarnings += 1;
  }
  return Object.freeze({ exceptions, logErrors, logWarnings });
}

export function createBrowserDiagnosticTracker(): Readonly<{
  record: (event: unknown) => void;
  reset: () => void;
  snapshot: () => Readonly<{ exceptions: number; logErrors: number; logWarnings: number }>;
  credentialAdded: () => boolean;
}> {
  let exceptions = 0;
  let logErrors = 0;
  let logWarnings = 0;
  let added = false;
  const increment = (value: number): number => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
  return Object.freeze({
    record(event: unknown) {
      if (!event || typeof event !== "object" || Array.isArray(event)) return;
      const message = event as Record<string, unknown>;
      if (message.method === "WebAuthn.credentialAdded") added = true;
      if (message.method === "Runtime.exceptionThrown") {
        exceptions = increment(exceptions);
        return;
      }
      if (message.method !== "Log.entryAdded" || !message.params || typeof message.params !== "object" || Array.isArray(message.params)) return;
      const entry = (message.params as Record<string, unknown>).entry;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
      const level = (entry as Record<string, unknown>).level;
      if (level === "error") logErrors = increment(logErrors);
      if (level === "warning") logWarnings = increment(logWarnings);
    },
    reset() {
      exceptions = 0;
      logErrors = 0;
      logWarnings = 0;
      added = false;
    },
    snapshot: () => Object.freeze({ exceptions, logErrors, logWarnings }),
    credentialAdded: () => added,
  });
}
