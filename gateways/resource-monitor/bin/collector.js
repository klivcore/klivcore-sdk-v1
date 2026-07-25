// @bun
// src/collector.ts
import { readFile as readFile2 } from "fs/promises";
import { isAbsolute } from "path";

// src/core.ts
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
function parseCpuCounters(text) {
  const line = text.split(`
`).find((candidate) => candidate.startsWith("cpu "));
  if (!line)
    throw new Error("/proc/stat is missing aggregate CPU counters");
  const values = line.trim().split(/\s+/u).slice(1).map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error("/proc/stat CPU counters are invalid");
  const idle = values[3] + (values[4] ?? 0);
  return Object.freeze({ idle, total: values.reduce((sum, value) => sum + value, 0) });
}
function cpuPercent(previous, current) {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0 || idle < 0 || idle > total)
    return 0;
  return Math.round(Math.max(0, Math.min(100, (1 - idle / total) * 100)) * 100) / 100;
}
function parseMemory(text) {
  const values = new Map;
  for (const line of text.split(`
`)) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB$/u.exec(line.trim());
    if (match)
      values.set(match[1], Number(match[2]) * 1024);
  }
  const totalBytes = values.get("MemTotal");
  const availableBytes = values.get("MemAvailable");
  if (!totalBytes || availableBytes === undefined || availableBytes < 0 || availableBytes > totalBytes)
    throw new Error("/proc/meminfo is invalid");
  return Object.freeze({ usedBytes: totalBytes - availableBytes, totalBytes });
}
function parseSample(value) {
  const invalid = () => {
    throw new TypeError("resource sample is invalid");
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid();
  const item = value;
  if (Object.keys(item).sort().join(",") !== "bootId,collectedAt,collectorId,cpuPercent,memoryTotalBytes,memoryUsedBytes,sequence" || typeof item.bootId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(item.bootId) || typeof item.collectorId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(item.collectorId) || !Number.isSafeInteger(item.sequence) || item.sequence < 1 || !Number.isSafeInteger(item.collectedAt) || item.collectedAt < 0 || typeof item.cpuPercent !== "number" || !Number.isFinite(item.cpuPercent) || item.cpuPercent < 0 || item.cpuPercent > 100 || !Number.isSafeInteger(item.memoryTotalBytes) || item.memoryTotalBytes < 1 || !Number.isSafeInteger(item.memoryUsedBytes) || item.memoryUsedBytes < 0 || item.memoryUsedBytes > item.memoryTotalBytes)
    invalid();
  return Object.freeze(item);
}

class SampleStore {
  #db;
  #insert;
  #query;
  #retain;
  constructor(path) {
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS samples (boot_id TEXT NOT NULL, collector_id TEXT NOT NULL, sequence INTEGER NOT NULL, collected_at INTEGER NOT NULL, cpu_percent REAL NOT NULL, memory_used_bytes INTEGER NOT NULL, memory_total_bytes INTEGER NOT NULL, PRIMARY KEY (boot_id, collector_id, sequence)); CREATE INDEX IF NOT EXISTS samples_time ON samples(collected_at DESC);");
    this.#insert = this.#db.prepare("INSERT OR IGNORE INTO samples (boot_id,collector_id,sequence,collected_at,cpu_percent,memory_used_bytes,memory_total_bytes) VALUES (?,?,?,?,?,?,?)");
    this.#query = this.#db.prepare("SELECT boot_id AS bootId, collector_id AS collectorId, sequence, collected_at AS collectedAt, cpu_percent AS cpuPercent, memory_used_bytes AS memoryUsedBytes, memory_total_bytes AS memoryTotalBytes FROM samples ORDER BY collected_at DESC, sequence DESC LIMIT ?");
    this.#retain = this.#db.prepare("DELETE FROM samples WHERE rowid IN (SELECT rowid FROM samples ORDER BY collected_at DESC, sequence DESC LIMIT -1 OFFSET 100000)");
  }
  ingest(values) {
    if (!Array.isArray(values) || values.length < 1 || values.length > 600)
      throw new TypeError("sample batch is invalid");
    const samples = values.map(parseSample);
    let accepted = 0;
    const transaction = this.#db.transaction(() => {
      for (const sample of samples) {
        const result = this.#insert.run(sample.bootId, sample.collectorId, sample.sequence, sample.collectedAt, sample.cpuPercent, sample.memoryUsedBytes, sample.memoryTotalBytes);
        accepted += Number(result.changes);
      }
      this.#retain.run();
    });
    transaction();
    return accepted;
  }
  recent(limit = 60) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 600)
      throw new RangeError("sample limit is invalid");
    return Object.freeze(this.#query.all(limit).map((sample) => Object.freeze(sample)));
  }
  close() {
    this.#db.close(false);
  }
}
async function assertPrivateFile(path) {
  const info = await lstat(path);
  const uid = process.getuid?.();
  if (!info.isFile() || info.isSymbolicLink() || process.platform !== "win32" && (info.mode & 511) !== 384 || uid !== undefined && info.uid !== uid || info.size < 1 || info.size > 4096)
    throw new Error(`unsafe private file: ${path}`);
}
async function atomicPrivateWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 448 });
  const stage = `${path}.stage-${randomUUID()}`;
  try {
    await writeFile(stage, content, { flag: "wx", mode: 384 });
    await rename(stage, path);
    if (process.platform !== "win32")
      await chmod(path, 384);
  } finally {
    await rm(stage, { force: true });
  }
}
async function ensureIngestToken(home) {
  await mkdir(home, { recursive: true, mode: 448 });
  const path = join(home, "ingest-token");
  try {
    const handle = await open(path, "wx", 384);
    try {
      await handle.writeFile(`${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}
`);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== "EEXIST")
      throw error;
  }
  await assertPrivateFile(path);
  const token = (await readFile(path, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error("ingestion token is invalid");
  return token;
}

class CollectorSpool {
  #path;
  #max;
  state;
  constructor(path, max, state) {
    this.#path = path;
    this.#max = max;
    this.state = state;
  }
  static async open(home, max = 720) {
    if (!Number.isSafeInteger(max) || max < 1 || max > 1e4)
      throw new RangeError("spool limit is invalid");
    const path = join(home, "collector-spool.json");
    let state = Object.freeze({ schemaVersion: 1, nextSequence: 1, samples: Object.freeze([]) });
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 1 || !Array.isArray(value.samples) || value.samples.length > max)
        throw new Error("collector spool is invalid");
      state = Object.freeze({ schemaVersion: 1, nextSequence: value.nextSequence, samples: Object.freeze(value.samples.map(parseSample)) });
    } catch (error) {
      if (error.code !== "ENOENT")
        throw error;
    }
    return new CollectorSpool(path, max, state);
  }
  async append(input) {
    const sample = parseSample({ ...input, sequence: this.state.nextSequence });
    const samples = [...this.state.samples, sample].slice(-this.#max);
    this.state = Object.freeze({ schemaVersion: 1, nextSequence: this.state.nextSequence + 1, samples: Object.freeze(samples) });
    await atomicPrivateWrite(this.#path, `${JSON.stringify(this.state)}
`);
    return sample;
  }
  async acknowledgeThrough(sequence) {
    const samples = this.state.samples.filter((sample) => sample.sequence > sequence);
    this.state = Object.freeze({ ...this.state, samples: Object.freeze(samples) });
    await atomicPrivateWrite(this.#path, `${JSON.stringify(this.state)}
`);
  }
}
async function stableCollectorId(home) {
  const path = join(home, "collector-id");
  await mkdir(home, { recursive: true, mode: 448 });
  try {
    const handle = await open(path, "wx", 384);
    try {
      await handle.writeFile(`${randomUUID()}
`);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== "EEXIST")
      throw error;
  }
  await assertPrivateFile(path);
  const value = (await readFile(path, "utf8")).trim();
  if (!/^[0-9a-f-]{36}$/.test(value))
    throw new Error("collector identity is invalid");
  return value;
}

// src/collector.ts
function parseCollectorConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("resource monitor config is invalid");
  const input = value;
  if (Object.keys(input).some((key) => key !== "collectionIntervalMs"))
    throw new TypeError("resource monitor config is invalid");
  const collectionIntervalMs = input.collectionIntervalMs ?? 5000;
  if (!Number.isSafeInteger(collectionIntervalMs) || collectionIntervalMs < 1000 || collectionIntervalMs > 60000)
    throw new TypeError("resource monitor config is invalid");
  return Object.freeze({ collectionIntervalMs });
}
async function flushSpool(input) {
  if (input.spool.state.samples.length === 0)
    return true;
  const request = input.fetch ?? fetch;
  try {
    const response = await request(`http://127.0.0.1:${input.port}/v1/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      body: JSON.stringify({ samples: input.spool.state.samples }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok)
      return false;
    await input.spool.acknowledgeThrough(input.spool.state.samples.at(-1).sequence);
    return true;
  } catch {
    return false;
  }
}
async function runCollector(options) {
  if (!isAbsolute(options.home) || !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535)
    throw new TypeError("collector options are invalid");
  const read = options.read ?? ((path) => readFile2(path, "utf8"));
  const sleep = options.sleep ?? Bun.sleep;
  const [token, collectorId, bootIdText, spool] = await Promise.all([
    ensureIngestToken(options.home),
    stableCollectorId(options.home),
    read("/proc/sys/kernel/random/boot_id"),
    CollectorSpool.open(options.home)
  ]);
  const bootId = bootIdText.trim();
  if (!/^[0-9a-f-]{36}$/i.test(bootId))
    throw new Error("Linux boot identity is invalid");
  let previous = parseCpuCounters(await read("/proc/stat"));
  await flushSpool({ port: options.port, token, spool });
  while (!options.signal?.aborted) {
    await sleep(options.config.collectionIntervalMs);
    if (options.signal?.aborted)
      break;
    const [cpuText, memoryText] = await Promise.all([read("/proc/stat"), read("/proc/meminfo")]);
    const current = parseCpuCounters(cpuText);
    const memory = parseMemory(memoryText);
    await spool.append({
      bootId,
      collectorId,
      collectedAt: Date.now(),
      cpuPercent: cpuPercent(previous, current),
      memoryUsedBytes: memory.usedBytes,
      memoryTotalBytes: memory.totalBytes
    });
    previous = current;
    await flushSpool({ port: options.port, token, spool });
  }
}
function requiredEnv(name) {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required`);
  return value;
}
if (import.meta.main) {
  const home = requiredEnv("KLIVCORE_GATEWAY_HOME");
  const port = Number(requiredEnv("KLIVCORE_GATEWAY_PORT"));
  const config = parseCollectorConfig(JSON.parse(await readFile2(requiredEnv("KLIVCORE_GATEWAY_CONFIG"), "utf8")));
  const controller = new AbortController;
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  console.log(`Resource Monitor collector started (${config.collectionIntervalMs}ms)`);
  await runCollector({ home, port, config, signal: controller.signal });
}
export {
  runCollector,
  parseCollectorConfig,
  flushSpool
};
