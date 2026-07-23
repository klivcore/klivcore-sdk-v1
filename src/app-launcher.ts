import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export type AppV2LauncherOptions = Readonly<{
  assetsRoot: string;
  hostname?: string;
  port?: number;
}>;

export type RunningAppV2Launcher = Readonly<{
  url: string;
  stop(): void;
}>;

export type PublishedAppV2 = Readonly<{
  respond(request: Request, fallbackToIndex?: boolean): Response | undefined;
}>;

type PublishedFile = Readonly<{ path: string; bytes: number; sha256: string }>;
type PublishedAsset = Readonly<{ body: Blob; bytes: number; contentType: string }>;

type PublicationManifest = Readonly<{
  schemaVersion: 1;
  source: Readonly<{ package: "@klivcore/app-v2"; version: string }>;
  files: readonly PublishedFile[];
}>;

const hashPattern = /^[a-f0-9]{64}$/;
const pathPattern = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FILES = 512;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export async function resolvePublishedAppV2Root(publicationRoot: string): Promise<string> {
  const root = resolve(publicationRoot);
  const rootStat = await lstat(root).catch(() => undefined);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error("App V2 publication root is missing or invalid");

  const pointerPath = join(root, "current.json");
  const pointerStat = await lstat(pointerPath).catch(() => undefined);
  if (!pointerStat?.isFile() || pointerStat.isSymbolicLink() || pointerStat.size > 1_024) {
    throw new Error("App V2 publication pointer is missing or invalid");
  }
  let pointer: unknown;
  try {
    pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  } catch {
    throw new Error("App V2 publication pointer is invalid");
  }
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) throw new Error("App V2 publication pointer is invalid");
  const record = pointer as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "release,schemaVersion"
    || record.schemaVersion !== 1
    || typeof record.release !== "string"
    || !hashPattern.test(record.release)
  ) {
    throw new Error("App V2 publication pointer is invalid");
  }

  const releasesRoot = join(root, "releases");
  const releasesStat = await lstat(releasesRoot).catch(() => undefined);
  if (!releasesStat?.isDirectory() || releasesStat.isSymbolicLink()) throw new Error("App V2 releases root is missing or invalid");
  const releaseRoot = join(releasesRoot, record.release);
  const releaseStat = await lstat(releaseRoot).catch(() => undefined);
  if (!releaseStat?.isDirectory() || releaseStat.isSymbolicLink()) throw new Error("App V2 current release is missing or invalid");
  const manifestPath = join(releaseRoot, "manifest.json");
  const manifestStat = await lstat(manifestPath).catch(() => undefined);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error("App V2 current release manifest is missing or invalid");
  }
  const manifestDigest = createHash("sha256").update(await readFile(manifestPath)).digest("hex");
  if (manifestDigest !== record.release) throw new Error("App V2 release content address does not match its manifest");
  return releaseRoot;
}

function failManifest(): never {
  throw new Error("App V2 publication manifest is invalid");
}

async function loadPublication(assetsRoot: string): Promise<ReadonlyMap<string, PublishedAsset>> {
  const manifestPath = join(assetsRoot, "manifest.json");
  const manifestStat = await lstat(manifestPath).catch(() => undefined);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) failManifest();
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    failManifest();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) failManifest();
  const manifest = value as Partial<PublicationManifest> & Record<string, unknown>;
  if (Object.keys(manifest).sort().join(",") !== "files,schemaVersion,source" || manifest.schemaVersion !== 1) failManifest();
  if (!manifest.source || typeof manifest.source !== "object" || Array.isArray(manifest.source)) failManifest();
  const source = manifest.source as Record<string, unknown>;
  if (Object.keys(source).sort().join(",") !== "package,version"
    || source.package !== "@klivcore/app-v2"
    || typeof source.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(source.version)) failManifest();
  if (!Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > MAX_FILES) failManifest();

  const files = new Map<string, PublishedAsset>();
  let totalBytes = 0;
  let previous = "";
  for (const input of manifest.files) {
    if (!input || typeof input !== "object" || Array.isArray(input)) failManifest();
    const file = input as Record<string, unknown>;
    if (Object.keys(file).sort().join(",") !== "bytes,path,sha256"
      || typeof file.path !== "string"
      || !pathPattern.test(file.path)
      || file.path === "manifest.json"
      || file.path <= previous
      || !Number.isSafeInteger(file.bytes)
      || (file.bytes as number) < 0
      || typeof file.sha256 !== "string"
      || !hashPattern.test(file.sha256)) failManifest();
    previous = file.path;
    totalBytes += file.bytes as number;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) failManifest();
    const absolute = resolve(assetsRoot, ...file.path.split("/"));
    const prefix = `${resolve(assetsRoot)}${sep}`;
    if (!absolute.startsWith(prefix)) failManifest();
    const stat = await lstat(absolute).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes) {
      throw new Error(`App V2 publication integrity check failed: ${file.path}`);
    }
    const data = await readFile(absolute);
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== file.sha256) throw new Error(`App V2 publication integrity check failed: ${file.path}`);
    const contentType = Bun.file(absolute).type || "application/octet-stream";
    files.set(`/${file.path}`, Object.freeze({
      body: new Blob([data], { type: contentType }),
      bytes: data.byteLength,
      contentType,
    }));
  }
  if (!files.has("/index.html")) failManifest();
  return files;
}

function publishedAppResponse(files: ReadonlyMap<string, PublishedAsset>, request: Request, fallbackToIndex = true): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad Request\n", { status: 400 });
  }
  if (pathname.includes("\0") || pathname.split("/").includes("..")) return new Response("Bad Request\n", { status: 400 });
  const exact = pathname === "/" ? files.get("/index.html") : files.get(pathname);
  const fallback = fallbackToIndex && !exact && !pathname.split("/").at(-1)?.includes(".") ? files.get("/index.html") : undefined;
  const asset = exact ?? fallback;
  if (!asset) return undefined;
  return new Response(request.method === "HEAD" ? null : asset.body, {
    headers: {
      "cache-control": pathname === "/" || pathname === "/index.html" || fallback ? "no-store" : "public, max-age=31536000, immutable",
      "content-length": String(asset.bytes),
      "content-type": asset.contentType,
      "x-content-type-options": "nosniff",
    },
  });
}

export async function loadPublishedAppV2(assetsRoot: string): Promise<PublishedAppV2> {
  const files = await loadPublication(resolve(assetsRoot));
  return Object.freeze({ respond(request, fallbackToIndex) { return publishedAppResponse(files, request, fallbackToIndex); } });
}

export async function startAppV2Launcher(options: AppV2LauncherOptions): Promise<RunningAppV2Launcher> {
  const assetsRoot = resolve(options.assetsRoot);
  const app = await loadPublishedAppV2(assetsRoot);
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 45174;
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "0.0.0.0") {
    throw new TypeError("launcher hostname must be local");
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new TypeError("launcher port is invalid");

  const server = Bun.serve({
    hostname,
    port,
    fetch(request) {
      return app.respond(request)
        ?? new Response("Method Not Allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
    },
  });
  const displayHostname = server.hostname === "0.0.0.0" ? "127.0.0.1" : server.hostname;
  return Object.freeze({
    url: `http://${displayHostname}:${server.port}/`,
    stop() { server.stop(true); },
  });
}
