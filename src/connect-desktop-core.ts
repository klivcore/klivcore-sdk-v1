export type DesktopPairingTarget = Readonly<{
  origin: string;
  pairingToken: string;
}>;

export type DesktopPairingResponse = Readonly<{
  schemaVersion: 1;
  realmId: string;
  realmName: string;
  relayUrl: string;
  sshUser: string;
  startingDirectory: string;
}>;

const CONNECT_DESKTOP_PACKAGE_PREFIX = "https://github.com/klivcore/klivcore-sdk-v1.git#";

export function parseConnectDesktopPackageSpec(value: string): string {
  if (!value.startsWith(CONNECT_DESKTOP_PACKAGE_PREFIX)
    || !/^[0-9a-f]{40}$/.test(value.slice(CONNECT_DESKTOP_PACKAGE_PREFIX.length))) {
    throw new TypeError("Desktop SDK package is invalid");
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

export function parseDesktopPairingUrl(value: string): DesktopPairingTarget {
  const invalid = (): never => { throw new TypeError("Desktop pairing URL is invalid"); };
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.protocol !== "https:" || url.pathname !== "/connect-desktop" || url.search
    || url.username || url.password || !/^#token=[A-Za-z0-9_-]{43}$/.test(url.hash)) invalid();
  return Object.freeze({ origin: url.origin, pairingToken: url.hash.slice("#token=".length) });
}

export function parseDesktopPairingResponse(origin: string, value: unknown): DesktopPairingResponse {
  const invalid = (): never => { throw new TypeError("Desktop pairing response is invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ["realmId", "realmName", "relayUrl", "schemaVersion", "sshUser", "startingDirectory"])
    || input.schemaVersion !== 1
    || typeof input.realmId !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(input.realmId)
    || typeof input.realmName !== "string" || input.realmName.length < 1 || input.realmName.length > 80 || /[\u0000-\u001f\u007f]/u.test(input.realmName)
    || typeof input.sshUser !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(input.sshUser)
    || typeof input.startingDirectory !== "string" || !input.startingDirectory.startsWith("/")
    || input.startingDirectory.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(input.startingDirectory)
    || typeof input.relayUrl !== "string") invalid();
  const realmId = input.realmId as string;
  const realmName = input.realmName as string;
  const relayHref = input.relayUrl as string;
  const sshUser = input.sshUser as string;
  const startingDirectory = input.startingDirectory as string;
  let relayUrl: URL;
  let publicOrigin: URL;
  try { relayUrl = new URL(relayHref); publicOrigin = new URL(origin); } catch { return invalid(); }
  if (relayUrl.protocol !== "wss:" || relayUrl.hostname !== publicOrigin.hostname || relayUrl.port !== publicOrigin.port
    || relayUrl.pathname !== "/v1/desktop/ssh" || relayUrl.search || relayUrl.hash || relayUrl.username || relayUrl.password) invalid();
  return Object.freeze({
    schemaVersion: 1,
    realmId,
    realmName,
    relayUrl: relayUrl.href,
    sshUser,
    startingDirectory,
  });
}

function marker(realmId: string, side: ">>>" | "<<<"): string {
  return `# ${side} Klivcore Connect Desktop: ${realmId} ${side}`;
}

export function renderManagedSshBlock(input: Readonly<{ realmId: string; sshUser: string; packageSpec: string }>): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(input.realmId)
    || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(input.sshUser)) throw new TypeError("Desktop SSH profile is invalid");
  const packageSpec = parseConnectDesktopPackageSpec(input.packageSpec);

  const alias = `klivcore-${input.realmId}`;
  return [
    marker(input.realmId, ">>>"),
    `Host ${alias}`,
    `  HostName ${input.realmId}.klivcore.invalid`,
    `  HostKeyAlias ${alias}`,
    `  User ${input.sshUser}`,
    "  IdentityFile ~/.klivcore/desktop/ssh-key/id_ed25519",
    "  IdentitiesOnly yes",
    `  ProxyCommand bunx --bun --package ${packageSpec} connect-desktop relay ${input.realmId}`,
    marker(input.realmId, "<<<"),
  ].join("\n");
}

export function preflightManagedSshConfig(existing: string): void {
  if (existing.length > 1024 * 1024) throw new RangeError("SSH config is too large to update safely");
  const markerPattern = /^# (>>>|<<<) Klivcore Connect Desktop: ([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?) \1$/;
  let openRealm: string | undefined;
  for (const line of existing.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.includes("Klivcore Connect Desktop:")) continue;
    const match = markerPattern.exec(line);
    if (!match) throw new Error("Existing managed SSH config block is malformed");
    const [, side, realmId] = match;
    if (side === ">>>") {
      if (openRealm) throw new Error("Existing managed SSH config block is malformed");
      openRealm = realmId;
    } else {
      if (openRealm !== realmId) throw new Error("Existing managed SSH config block is malformed");
      openRealm = undefined;
    }
  }
  if (openRealm) throw new Error("Existing managed SSH config block is malformed");
}

export function mergeManagedSshConfig(existing: string, realmId: string, block: string): string {
  preflightManagedSshConfig(existing);
  const startMarker = marker(realmId, ">>>");
  const endMarker = marker(realmId, "<<<");
  const lines = existing.replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf(startMarker);
  const end = lines.indexOf(endMarker);
  if ((start < 0) !== (end < 0) || (start >= 0 && (end < start || lines.indexOf(startMarker, start + 1) >= 0 || lines.indexOf(endMarker, end + 1) >= 0))) {
    throw new Error("Existing managed SSH config block is malformed");
  }
  if (start >= 0) lines.splice(start, end - start + 1);
  const base = lines.join("\n").trim();
  return `${block}\n${base ? `\n${base}\n` : ""}`;
}
