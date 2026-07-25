// @bun
// packages/publish-sdk/src/gateway-collector.ts
import { readFile as readFile2 } from "fs/promises";
import { resolve as resolve2 } from "path";

// packages/types/src/index.ts
var RESOURCE_MONITOR_PROTOCOL_VERSION = 1;
// packages/core/src/index.ts
var ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var CATEGORY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/;
var SENSITIVE_ATTRIBUTE_NAME = /(secret|credential|password|passphrase|apikey|accesstoken|authtoken|connectionstring|prompt|tooloutput|providerpayload)/;
var MAX_TEXT = 256;
var MAX_ATTRIBUTES = 32;
function boundedText(value, label, max = MAX_TEXT) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new TypeError(`${label} must be bounded text`);
  }
  return value;
}
function identifier(value, label) {
  const parsed = boundedText(value, label, 128);
  if (!ID.test(parsed))
    throw new TypeError(`${label} is invalid`);
  return parsed;
}
function categoryIdentifier(value, label) {
  const parsed = boundedText(value, label, 128);
  if (!CATEGORY_ID.test(parsed))
    throw new TypeError(`${label} is invalid`);
  return parsed;
}
function canonicalDescriptor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("descriptor must be an object");
  if (input.schemaVersion !== 1)
    throw new TypeError("descriptor schemaVersion must be 1");
  const attributes = input.attributes?.map((attribute, index) => {
    if (!attribute || typeof attribute !== "object" || Array.isArray(attribute))
      throw new TypeError(`descriptor attribute ${index} is invalid`);
    if (!["string", "number", "boolean", "null"].includes(attribute.type))
      throw new TypeError(`descriptor attribute ${index} type is invalid`);
    const name = identifier(attribute.name, `descriptor attribute ${index} name`);
    if (SENSITIVE_ATTRIBUTE_NAME.test(name.toLowerCase().replace(/[^a-z]/g, "")))
      throw new TypeError(`descriptor attribute ${index} is a sensitive attribute`);
    return Object.freeze({ name, type: attribute.type });
  });
  if ((attributes?.length ?? 0) > MAX_ATTRIBUTES)
    throw new TypeError("descriptor has too many attributes");
  if (attributes && new Set(attributes.map((attribute) => attribute.name)).size !== attributes.length)
    throw new TypeError("descriptor has duplicate attributes");
  const measurement = input.measurement === undefined ? undefined : Object.freeze({
    name: identifier(input.measurement.name, "descriptor measurement name"),
    ...input.measurement.unit === undefined ? {} : { unit: boundedText(input.measurement.unit, "descriptor measurement unit", 64) }
  });
  return Object.freeze({
    schemaVersion: 1,
    sourceId: identifier(input.sourceId, "descriptor sourceId"),
    ...input.categoryId === undefined ? {} : { categoryId: categoryIdentifier(input.categoryId, "descriptor categoryId") },
    eventType: identifier(input.eventType, "descriptor eventType"),
    ...measurement === undefined ? {} : { measurement },
    ...attributes === undefined ? {} : { attributes: Object.freeze(attributes) }
  });
}
function descriptorBytes(descriptor) {
  const attributes = descriptor.attributes?.map(({ name, type }) => [name, type]) ?? null;
  const measurement = descriptor.measurement ? [descriptor.measurement.name, descriptor.measurement.unit ?? null] : null;
  return new TextEncoder().encode(JSON.stringify([
    descriptor.schemaVersion,
    descriptor.sourceId,
    descriptor.categoryId ?? null,
    descriptor.eventType,
    measurement,
    attributes
  ]));
}
function fnv32(bytes, seed) {
  let hash = seed >>> 0;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}
function descriptorHash(descriptor) {
  const bytes = descriptorBytes(descriptor);
  return [2166136261, 2654435761, 2246822519, 3266489917].map((seed) => fnv32(bytes, seed).toString(16).padStart(8, "0")).join("");
}
function createEventDescriptor(input) {
  const descriptor = canonicalDescriptor(input);
  return Object.freeze({ hash: descriptorHash(descriptor), descriptor });
}

// packages/collector-linux/src/index.ts
import { readdir, readlink } from "fs/promises";
var MAX_LISTENER_PORTS = 64;
var MAX_LISTENER_OWNER_JSON = 512;
var LISTENER_OWNER_CACHE_MS = 5000;
function finiteCounter(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new TypeError(`${label} is invalid`);
  return parsed;
}
function parseProcStat(text) {
  const line = text.split(/\r?\n/u).find((candidate) => candidate.startsWith("cpu "));
  if (!line)
    throw new TypeError("/proc/stat aggregate CPU row is missing");
  const values = line.trim().split(/\s+/u).slice(1).map((value) => finiteCounter(value, "/proc/stat CPU counter"));
  if (values.length < 4)
    throw new TypeError("/proc/stat aggregate CPU row is incomplete");
  const total = values.reduce((sum, value) => sum + value, 0);
  const idle = values[3] + (values[4] ?? 0);
  return Object.freeze({ total, idle });
}
function computeCpuUtilization(previous, current) {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta)
    return;
  return Math.round((totalDelta - idleDelta) / totalDelta * 1e4) / 100;
}
function parseProcMeminfo(text) {
  const values = new Map;
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB$/u.exec(line.trim());
    if (match)
      values.set(match[1], finiteCounter(match[2], `/proc/meminfo ${match[1]}`) * 1024);
  }
  const totalBytes = values.get("MemTotal");
  const availableBytes = values.get("MemAvailable");
  if (!totalBytes || availableBytes === undefined || availableBytes > totalBytes) {
    throw new TypeError("/proc/meminfo memory totals are invalid");
  }
  const usedBytes = totalBytes - availableBytes;
  return Object.freeze({
    totalBytes,
    availableBytes,
    usedBytes,
    utilizationPercent: Math.round(usedBytes / totalBytes * 1e4) / 100
  });
}
function listenerSockets(text) {
  const sockets = [];
  for (const line of text.split(/\r?\n/u).slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 4 || fields[3] !== "0A")
      continue;
    const local = fields[1];
    const separator = local?.lastIndexOf(":") ?? -1;
    if (!local || separator < 0)
      continue;
    const port = Number.parseInt(local.slice(separator + 1), 16);
    if (Number.isSafeInteger(port) && port >= 1 && port <= 65535) {
      const inode = fields[9];
      sockets.push(Object.freeze({ port, .../^\d+$/u.test(inode ?? "") ? { inode } : {} }));
    }
  }
  return sockets;
}
function parseTcpListenerSockets(tcp, tcp6) {
  const unique = new Map;
  for (const socket of [...listenerSockets(tcp), ...listenerSockets(tcp6)])
    unique.set(`${socket.port}
${socket.inode ?? ""}`, socket);
  return Object.freeze([...unique.values()].sort((left, right) => left.port - right.port || String(left.inode ?? "").localeCompare(String(right.inode ?? ""))));
}
function boundedListeners(tcp, tcp6) {
  const sockets = parseTcpListenerSockets(tcp, tcp6);
  const all = [...new Set(sockets.map((socket) => socket.port))].sort((left, right) => left - right);
  const ports = Object.freeze(all.slice(0, MAX_LISTENER_PORTS));
  const included = new Set(ports);
  return Object.freeze({ ports, sockets: Object.freeze(sockets.filter((socket) => included.has(socket.port))), truncated: all.length > MAX_LISTENER_PORTS });
}
function safeTitlePart(value, max) {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}
async function resolveTcpListenerOwners(sockets, procfs) {
  const portsByInode = new Map;
  for (const socket of sockets) {
    if (!socket.inode)
      continue;
    const ports = portsByInode.get(socket.inode) ?? new Set;
    ports.add(socket.port);
    portsByInode.set(socket.inode, ports);
  }
  const owners = new Map;
  if (portsByInode.size === 0)
    return owners;
  let entries;
  try {
    entries = await procfs.readDirectory("/proc");
  } catch {
    return owners;
  }
  for (const pidText of [...entries].filter((entry) => /^(?:[1-9]\d*)$/u.test(entry)).sort((left, right) => Number(left) - Number(right))) {
    const pid = Number(pidText);
    let fds;
    try {
      fds = await procfs.readDirectory(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    const matched = new Set;
    for (const fd of fds) {
      try {
        const match = /^socket:\[(\d+)\]$/u.exec(await procfs.readLink(`/proc/${pid}/fd/${fd}`));
        if (match && portsByInode.has(match[1]))
          matched.add(match[1]);
      } catch {}
    }
    if (matched.size === 0)
      continue;
    let comm = "";
    let cwd = "";
    try {
      comm = safeTitlePart(await procfs.readText(`/proc/${pid}/comm`), 32);
    } catch {}
    try {
      cwd = safeTitlePart((await procfs.readLink(`/proc/${pid}/cwd`)).split("/").filter(Boolean).at(-1) ?? "", 64);
    } catch {}
    const title = safeTitlePart(cwd && cwd !== comm ? `${cwd} \xB7 ${comm || "process"}` : comm || cwd || "process", 96);
    const owner = Object.freeze({ pid, title });
    for (const inode of matched)
      for (const port of portsByInode.get(inode) ?? [])
        if (!owners.has(port))
          owners.set(port, owner);
    if (owners.size >= new Set(sockets.map((socket) => socket.port)).size)
      break;
  }
  return owners;
}
function encodeListenerOwners(owners) {
  const encoded = {};
  let json = "{}";
  let truncated = false;
  for (const [port, owner] of [...owners].sort(([left], [right]) => left - right)) {
    encoded[String(port)] = Object.freeze([owner.pid, safeTitlePart(owner.title, 96)]);
    const candidate = JSON.stringify(encoded);
    if (candidate.length > MAX_LISTENER_OWNER_JSON) {
      delete encoded[String(port)];
      truncated = true;
      break;
    }
    json = candidate;
  }
  return Object.freeze({ json, truncated: truncated || Object.keys(encoded).length < owners.size });
}
var cpuDescriptor = createEventDescriptor({
  schemaVersion: 1,
  sourceId: "linux.machine",
  categoryId: "machine/cpu",
  eventType: "machine.cpu.utilization",
  measurement: { name: "utilization", unit: "percent" },
  attributes: [{ name: "observationScope", type: "string" }]
});
var memoryDescriptor = createEventDescriptor({
  schemaVersion: 1,
  sourceId: "linux.machine",
  categoryId: "machine/memory",
  eventType: "machine.memory.utilization",
  measurement: { name: "utilization", unit: "percent" },
  attributes: [
    { name: "observationScope", type: "string" },
    { name: "totalBytes", type: "number" },
    { name: "availableBytes", type: "number" }
  ]
});
var listenersDescriptor = createEventDescriptor({
  schemaVersion: 1,
  sourceId: "linux.machine",
  categoryId: "machine/network",
  eventType: "machine.tcp.listeners",
  measurement: { name: "listeners", unit: "count" },
  attributes: [
    { name: "observationScope", type: "string" },
    { name: "ports", type: "string" },
    { name: "truncated", type: "boolean" },
    { name: "owners", type: "string" },
    { name: "ownersTruncated", type: "boolean" }
  ]
});
function createLinuxMachineCollector(options) {
  const readText = options.readText ?? ((path) => Bun.file(path).text());
  const procfs = Object.freeze({
    readDirectory: options.readDirectory ?? ((path) => readdir(path)),
    readLink: options.readLink ?? readlink,
    readText
  });
  const ownerCacheNow = options.ownerCacheNow ?? Date.now;
  const now = options.now ?? Date.now;
  let previousCpu;
  let sourceSequence = 0;
  let cachedOwners = new Map;
  let ownersCachedAt = Number.NEGATIVE_INFINITY;
  let ownerSocketKey = "";
  return Object.freeze({
    async sample() {
      const [stat, meminfo, tcp, tcp6] = await Promise.all([
        readText("/proc/stat"),
        readText("/proc/meminfo"),
        readText("/proc/net/tcp"),
        readText("/proc/net/tcp6")
      ]);
      const currentCpu = parseProcStat(stat);
      const cpuUtilization = previousCpu === undefined ? undefined : computeCpuUtilization(previousCpu, currentCpu);
      previousCpu = currentCpu;
      const memory = parseProcMeminfo(meminfo);
      const listeners = boundedListeners(tcp, tcp6);
      const cacheAt = ownerCacheNow();
      const nextOwnerSocketKey = listeners.sockets.map((socket) => `${socket.port}:${socket.inode ?? ""}`).join(",");
      if (nextOwnerSocketKey !== ownerSocketKey || cacheAt - ownersCachedAt >= LISTENER_OWNER_CACHE_MS) {
        cachedOwners = await resolveTcpListenerOwners(listeners.sockets, procfs);
        ownersCachedAt = cacheAt;
        ownerSocketKey = nextOwnerSocketKey;
      }
      const encodedOwners = encodeListenerOwners(cachedOwners);
      const eventTimestamp = now();
      const events = [];
      if (cpuUtilization !== undefined)
        events.push({
          descriptorHash: cpuDescriptor.hash,
          sourceSequence: ++sourceSequence,
          eventTimestamp,
          measurement: { value: cpuUtilization, min: 0, max: 100 },
          attributes: [options.observationScope]
        });
      events.push({
        descriptorHash: memoryDescriptor.hash,
        sourceSequence: ++sourceSequence,
        eventTimestamp,
        measurement: { value: memory.utilizationPercent, min: 0, max: 100 },
        attributes: [options.observationScope, memory.totalBytes, memory.availableBytes]
      });
      events.push({
        descriptorHash: listenersDescriptor.hash,
        sourceSequence: ++sourceSequence,
        eventTimestamp,
        measurement: { value: listeners.ports.length, min: 0 },
        attributes: [options.observationScope, listeners.ports.join(","), listeners.truncated, encodedOwners.json, encodedOwners.truncated]
      });
      return Object.freeze({
        protocolVersion: RESOURCE_MONITOR_PROTOCOL_VERSION,
        sourceInstanceId: options.sourceInstanceId,
        ...options.replacesSourceInstanceId === undefined ? {} : { replacesSourceInstanceId: options.replacesSourceInstanceId },
        definitions: Object.freeze([cpuDescriptor, memoryDescriptor, listenersDescriptor]),
        events: Object.freeze(events)
      });
    }
  });
}

// apps/machine-collector/src/runtime.ts
function defaultWait(durationMs, signal) {
  if (signal.aborted)
    return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, durationMs);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
async function runMachineCollector(options) {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 100 || options.intervalMs > 300000) {
    throw new TypeError("machine collector interval is invalid");
  }
  const wait = options.wait ?? defaultWait;
  while (!options.signal.aborted) {
    try {
      const batch = await options.collector.sample();
      const result = await options.client.ingest(batch);
      await options.onAcknowledged?.(batch, result);
    } catch (error) {
      if (!options.signal.aborted)
        options.onError?.(error instanceof Error ? error : new Error("machine collection failed"));
    }
    if (!options.signal.aborted)
      await wait(options.intervalMs, options.signal);
  }
}

// apps/machine-collector/src/source-state.ts
import { randomUUID } from "crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "fs/promises";
import { dirname, parse, relative, resolve, sep } from "path";
var MAX_STATE_BYTES = 2048;
var IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function identifier2(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value))
    throw new TypeError(`machine collector source state ${label} is invalid`);
  return value;
}
async function privateDirectory(path) {
  const directory = resolve(dirname(path));
  const root = parse(directory).root;
  let current = root;
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink())
        throw new Error(`machine collector source state path contains a symbolic link: ${current}`);
      if (!metadata.isDirectory())
        throw new Error(`machine collector source state path is not a directory: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT")
        throw error;
      await mkdir(current, { mode: 448 });
    }
  }
  await chmod(directory, 448);
  return directory;
}
function parseState(text) {
  if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES)
    throw new TypeError("machine collector source state is oversized");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError("machine collector source state is malformed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("machine collector source state is invalid");
  const record = value;
  const allowed = new Set(["version", "phase", "sourceInstanceId", "replacesSourceInstanceId"]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || record.version !== 1 || record.phase !== "pending" && record.phase !== "active") {
    throw new TypeError("machine collector source state is invalid");
  }
  const sourceInstanceId = identifier2(record.sourceInstanceId, "sourceInstanceId");
  const replacesSourceInstanceId = record.replacesSourceInstanceId === undefined ? undefined : identifier2(record.replacesSourceInstanceId, "replacesSourceInstanceId");
  if (replacesSourceInstanceId === sourceInstanceId)
    throw new TypeError("machine collector source state cannot replace itself");
  return Object.freeze({
    version: 1,
    phase: record.phase,
    sourceInstanceId,
    ...replacesSourceInstanceId === undefined ? {} : { replacesSourceInstanceId }
  });
}
async function readState(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink())
      throw new Error("machine collector source state path is a symbolic link");
    if (!metadata.isFile())
      throw new Error("machine collector source state path is not a regular file");
    if (metadata.size > MAX_STATE_BYTES)
      throw new TypeError("machine collector source state is oversized");
    await chmod(path, 384);
    return parseState(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      return;
    throw error;
  }
}
async function writeState(path, state) {
  const directory = await privateDirectory(path);
  const existing = await readState(path);
  const bytes = `${JSON.stringify(state)}
`;
  if (Buffer.byteLength(bytes, "utf8") > MAX_STATE_BYTES)
    throw new TypeError("machine collector source state is oversized");
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 384);
    await handle.writeFile(bytes, "utf8");
    await handle.chmod(384);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await chmod(path, 384);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}
function sourceFromState(state) {
  return Object.freeze({
    sourceInstanceId: state.sourceInstanceId,
    ...state.replacesSourceInstanceId === undefined ? {} : { replacesSourceInstanceId: state.replacesSourceInstanceId }
  });
}
async function claimMachineCollectorSource(path, initialReplacesSourceInstanceId, generateSourceInstanceId = () => `linux-machine-${randomUUID()}`) {
  await privateDirectory(path);
  const previous = await readState(path);
  if (previous?.phase === "pending")
    return sourceFromState(previous);
  const sourceInstanceId = identifier2(generateSourceInstanceId(), "sourceInstanceId");
  const replacesSourceInstanceId = previous?.sourceInstanceId ?? (initialReplacesSourceInstanceId === undefined ? undefined : identifier2(initialReplacesSourceInstanceId, "initialReplacesSourceInstanceId"));
  if (sourceInstanceId === replacesSourceInstanceId)
    throw new TypeError("machine collector source state cannot replace itself");
  const pending = Object.freeze({
    version: 1,
    phase: "pending",
    sourceInstanceId,
    ...replacesSourceInstanceId === undefined ? {} : { replacesSourceInstanceId }
  });
  await writeState(path, pending);
  return sourceFromState(pending);
}
async function activateMachineCollectorSource(path, source) {
  await privateDirectory(path);
  const state = await readState(path);
  if (!state || state.sourceInstanceId !== source.sourceInstanceId || state.replacesSourceInstanceId !== source.replacesSourceInstanceId) {
    throw new Error("machine collector source state changed before acknowledgement");
  }
  if (state.phase === "active")
    return;
  await writeState(path, Object.freeze({ ...state, phase: "active" }));
}

// packages/publish-sdk/src/gateway-collector.ts
function requiredAbsolute(name) {
  const value = process.env[name];
  if (!value || !resolve2(value).startsWith("/"))
    throw new Error(`${name} must be absolute`);
  return resolve2(value);
}
var home = requiredAbsolute("KLIVCORE_GATEWAY_HOME");
var configPath = requiredAbsolute("KLIVCORE_GATEWAY_CONFIG");
var portText = process.env.KLIVCORE_GATEWAY_PORT;
if (!portText || !/^[1-9]\d{0,4}$/u.test(portText) || Number(portText) > 65535)
  throw new Error("KLIVCORE_GATEWAY_PORT is invalid");
var config = JSON.parse(await readFile2(configPath, "utf8"));
var intervalMs = config.collectionIntervalMs === undefined ? 5000 : Number(config.collectionIntervalMs);
if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 300000)
  throw new TypeError("Resource Monitor collection interval is invalid");
var observationScope = config.observationScope ?? "host";
if (observationScope !== "host" && observationScope !== "vm" && observationScope !== "container")
  throw new TypeError("Resource Monitor observation scope is invalid");
var token = (await readFile2(resolve2(home, "ingest-token"), "utf8")).trim();
if (!/^[A-Za-z0-9_-]{43}$/u.test(token))
  throw new Error("Resource Monitor ingestion token is invalid");
var runtime = JSON.parse(await readFile2(resolve2(home, "collector-runtime.json"), "utf8"));
if (runtime.schemaVersion !== 1 || runtime.initialReplacesSourceInstanceId !== null && typeof runtime.initialReplacesSourceInstanceId !== "string")
  throw new Error("Resource Monitor collector runtime is invalid");
var sourceStatePath = resolve2(home, "machine-collector-source-state.json");
var source = await claimMachineCollectorSource(sourceStatePath, runtime.initialReplacesSourceInstanceId ?? undefined);
var collector = createLinuxMachineCollector({ ...source, observationScope });
var controller = new AbortController;
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
var sourceActivated = false;
async function ingest(batch) {
  const response = await fetch(`http://127.0.0.1:${portText}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(batch)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Resource Monitor ingest failed with ${response.status}`);
  }
  return await response.json();
}
console.log(`Canonical Resource Monitor collector started (${observationScope} scope, ${intervalMs} ms cadence)`);
await runMachineCollector({
  signal: controller.signal,
  intervalMs,
  collector,
  client: { ingest },
  async onAcknowledged() {
    if (sourceActivated)
      return;
    await activateMachineCollectorSource(sourceStatePath, source);
    sourceActivated = true;
  },
  onError(error) {
    console.error(`Resource Monitor collector retrying: ${error.message}`);
  }
});
