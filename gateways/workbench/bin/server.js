// @bun
// packages/publish-sdk/src/gateway-server.ts
import { readFile as readFile2 } from "fs/promises";
import { resolve as resolve2 } from "path";

// packages/publish-sdk/src/gateway-server-core.ts
import { chmod, lstat, mkdir, open, readFile, rename } from "fs/promises";
import { randomUUID } from "crypto";
import { resolve } from "path";

// packages/publish-sdk/src/gateway-contract.ts
var WORKBENCH_GATEWAY_MAX_BYTES = 1024 * 1024;
var WORKBENCH_GATEWAY_MAX_ELEMENTS = 1000;
var WORKBENCH_GATEWAY_MAX_EDGES = 2000;
var ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
var HEX = /^#[0-9a-fA-F]{6}$/u;
function createDefaultGatewayBench() {
  return parseGatewayBench({
    schemaVersion: 1,
    name: "Acme modular workbench",
    elements: [
      { id: "group:system", type: "group", label: "Modular system", x: 40, y: 40, width: 920, height: 520 },
      { id: "square:realm", type: "square", color: "blue", parentId: "group:system", x: 100, y: 150, size: 130 },
      { id: "rect:gateways", type: "rect", color: "#22c55e", parentId: "group:system", x: 390, y: 135, width: 230, height: 160 },
      { id: "text:intro", type: "text", parentId: "group:system", x: 680, y: 120, width: 220, height: 190, value: `# Workbench Gateway

Square, rectangle, text, group, and edge elements are persisted by this isolated Gateway.` }
    ],
    edges: [{ id: "edge:realm-gateways", type: "edge", from: { elementId: "square:realm" }, to: { elementId: "rect:gateways" }, color: "#38bdf8" }]
  });
}
function parseGatewayBench(value) {
  const root = record(value, "Workbench document");
  exact(root, ["schemaVersion", "name", "elements", "edges"], "Workbench document");
  if (root.schemaVersion !== 1)
    throw new TypeError("Workbench schemaVersion must be 1");
  const name = boundedString(root.name, 1, 200, "Workbench name");
  if (!Array.isArray(root.elements) || root.elements.length > WORKBENCH_GATEWAY_MAX_ELEMENTS)
    throw new TypeError("Workbench element limit exceeded");
  if (!Array.isArray(root.edges) || root.edges.length > WORKBENCH_GATEWAY_MAX_EDGES)
    throw new TypeError("Workbench edge limit exceeded");
  const ids = new Set;
  const elements = root.elements.map((entry, index) => parseElement(entry, index, ids));
  const elementIds = new Set(elements.map((entry) => entry.id));
  for (const element of elements)
    if (element.parentId !== undefined && !elementIds.has(element.parentId))
      throw new TypeError(`Workbench parent does not exist: ${element.parentId}`);
  const edges = root.edges.map((entry, index) => parseEdge(entry, index, ids, elementIds));
  const bench = { schemaVersion: 1, name, elements: Object.freeze(elements), edges: Object.freeze(edges) };
  if (new TextEncoder().encode(JSON.stringify(bench)).byteLength > WORKBENCH_GATEWAY_MAX_BYTES)
    throw new TypeError("Workbench document exceeds byte limit");
  return Object.freeze(bench);
}
function parseElement(value, index, ids) {
  const entry = record(value, `Workbench element ${index}`);
  const type = entry.type;
  if (type !== "square" && type !== "rect" && type !== "text" && type !== "group")
    throw new TypeError(`Unsupported Workbench element type: ${String(type)}`);
  const common = parseElementCommon(entry, index, ids);
  if (type === "square") {
    exact(entry, ["id", "type", "color", "parentId", "x", "y", "size"], `Workbench square ${common.id}`);
    if (entry.color !== "red" && entry.color !== "blue" && entry.color !== "green")
      throw new TypeError("Workbench square color is invalid");
    return Object.freeze({ ...common, type, color: entry.color, size: positive(entry.size, "Workbench square size") });
  }
  if (type === "rect") {
    exact(entry, ["id", "type", "color", "parentId", "x", "y", "width", "height"], `Workbench rect ${common.id}`);
    if (typeof entry.color !== "string" || !HEX.test(entry.color))
      throw new TypeError("Workbench rect color is invalid");
    return Object.freeze({ ...common, type, color: entry.color.toLowerCase(), width: positive(entry.width, "Workbench rect width"), height: positive(entry.height, "Workbench rect height") });
  }
  if (type === "text") {
    exact(entry, ["id", "type", "value", "parentId", "x", "y", "width", "height"], `Workbench text ${common.id}`);
    return Object.freeze({ ...common, type, value: boundedString(entry.value, 0, 32000, "Workbench text value"), width: positive(entry.width, "Workbench text width"), height: positive(entry.height, "Workbench text height") });
  }
  exact(entry, ["id", "type", "label", "parentId", "x", "y", "width", "height"], `Workbench group ${common.id}`);
  return Object.freeze({ ...common, type, label: boundedString(entry.label, 0, 200, "Workbench group label"), width: positive(entry.width, "Workbench group width"), height: positive(entry.height, "Workbench group height") });
}
function parseElementCommon(entry, index, ids) {
  const id = parseId(entry.id, `Workbench element ${index} id`);
  if (ids.has(id))
    throw new TypeError(`Duplicate Workbench id: ${id}`);
  ids.add(id);
  return Object.freeze({ id, ...entry.parentId === undefined ? {} : { parentId: parseId(entry.parentId, "Workbench parentId") }, x: finite(entry.x, "Workbench x"), y: finite(entry.y, "Workbench y") });
}
function parseEdge(value, index, ids, elementIds) {
  const entry = record(value, `Workbench edge ${index}`);
  exact(entry, ["id", "type", "from", "to", "color"], `Workbench edge ${index}`);
  const id = parseId(entry.id, `Workbench edge ${index} id`);
  if (ids.has(id))
    throw new TypeError(`Duplicate Workbench id: ${id}`);
  ids.add(id);
  if (entry.type !== "edge")
    throw new TypeError("Workbench edge type is invalid");
  const endpoint = (candidate, label) => {
    const endpointRecord = record(candidate, label);
    exact(endpointRecord, ["elementId"], label);
    const elementId = parseId(endpointRecord.elementId, `${label} elementId`);
    if (!elementIds.has(elementId))
      throw new TypeError(`${label} element does not exist`);
    return Object.freeze({ elementId });
  };
  const color = entry.color === undefined ? undefined : entry.color;
  if (color !== undefined && (typeof color !== "string" || !HEX.test(color)))
    throw new TypeError("Workbench edge color is invalid");
  return Object.freeze({ id, type: "edge", from: endpoint(entry.from, "Workbench edge from"), to: endpoint(entry.to, "Workbench edge to"), ...color === undefined ? {} : { color: color.toLowerCase() } });
}
function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError(`${label} must be an object`);
  return value;
}
function exact(value, allowed, label) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown)
    throw new TypeError(`${label} has unknown field: ${unknown}`);
}
function parseId(value, label) {
  if (typeof value !== "string" || !ID.test(value))
    throw new TypeError(`${label} is invalid`);
  return value;
}
function boundedString(value, minimum, maximum, label) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum)
    throw new TypeError(`${label} is invalid`);
  return value;
}
function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e6)
    throw new TypeError(`${label} must be finite`);
  return value;
}
function positive(value, label) {
  const result = finite(value, label);
  if (result < 16 || result > 1e5)
    throw new TypeError(`${label} is outside the supported range`);
  return result;
}

// packages/publish-sdk/src/gateway-server-core.ts
async function createWorkbenchGatewayHandler(homePath) {
  const home = resolve(homePath);
  await mkdir(home, { recursive: true, mode: 448 });
  await chmod(home, 448);
  const benchPath = resolve(home, "workbench.bench.json");
  let bench = await loadOrCreate(benchPath, home);
  let writes = Promise.resolve();
  return async (request) => {
    const url = new URL(request.url);
    if (url.search || url.hash)
      return json({ error: "invalid-request-target" }, 400);
    if (request.method === "GET" && url.pathname === "/health")
      return json({ status: "ok", gateway: "workbench-v1" });
    if (request.method === "GET" && url.pathname === "/v1/bootstrap") {
      return json({ schemaVersion: 1, documentPath: "/v1/bench", elementTypes: ["square", "rect", "text", "group"], edgeTypes: ["edge"] });
    }
    if (url.pathname !== "/v1/bench")
      return json({ error: "not-found" }, 404);
    if (request.method === "GET")
      return json(bench);
    if (request.method !== "POST")
      return json({ error: "method-not-allowed" }, 405, { allow: "GET, POST" });
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("content-type") ?? ""))
      return json({ error: "content-type" }, 415);
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > WORKBENCH_GATEWAY_MAX_BYTES))
      return json({ error: "request-too-large" }, 413);
    try {
      const candidate = parseGatewayBench(await readBoundedJson(request, WORKBENCH_GATEWAY_MAX_BYTES));
      const current = writes.then(async () => {
        await persistBench(benchPath, home, candidate, false);
        bench = candidate;
      });
      writes = current.catch(() => {
        return;
      });
      await current;
      return json(bench);
    } catch (error) {
      if (error instanceof RangeError)
        return json({ error: "request-too-large" }, 413);
      return json({ error: "invalid-workbench" }, 400);
    }
  };
}
async function loadOrCreate(path, home) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > WORKBENCH_GATEWAY_MAX_BYTES)
      throw new Error("unsafe Workbench persistence file");
    const bench = parseGatewayBench(JSON.parse(await readFile(path, "utf8")));
    await chmod(path, 384);
    return bench;
  } catch (error) {
    if (error.code !== "ENOENT")
      throw error;
    const bench = createDefaultGatewayBench();
    await persistBench(path, home, bench, true);
    return bench;
  }
}
async function persistBench(path, home, bench, exclusive) {
  const text = `${JSON.stringify(bench, null, 2)}
`;
  if (new TextEncoder().encode(text).byteLength > WORKBENCH_GATEWAY_MAX_BYTES)
    throw new RangeError("Workbench document exceeds byte limit");
  const temp = resolve(home, `.workbench.bench.${randomUUID()}.tmp`);
  const handle = await open(exclusive ? path : temp, "wx", 384);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!exclusive)
    await rename(temp, path);
  await chmod(path, 384);
  const directory = await open(home, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function readBoundedJson(request, maximum) {
  if (!request.body)
    throw new TypeError("request body is missing");
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done)
        break;
      length += result.value.byteLength;
      if (length > maximum) {
        await reader.cancel("request too large");
        throw new RangeError("request too large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
}

// packages/publish-sdk/src/gateway-server.ts
function requiredAbsolute(name) {
  const value = process.env[name];
  if (!value || !resolve2(value).startsWith("/"))
    throw new Error(`${name} must be absolute`);
  return resolve2(value);
}
function requiredPort() {
  const value = process.env.KLIVCORE_GATEWAY_PORT;
  if (!value || !/^[1-9]\d{0,4}$/u.test(value) || Number(value) > 65535)
    throw new Error("KLIVCORE_GATEWAY_PORT is invalid");
  return Number(value);
}
var home = requiredAbsolute("KLIVCORE_GATEWAY_HOME");
var configPath = requiredAbsolute("KLIVCORE_GATEWAY_CONFIG");
var config = JSON.parse(await readFile2(configPath, "utf8"));
if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).length !== 0)
  throw new TypeError("Workbench Gateway config must be an empty object");
var handler = await createWorkbenchGatewayHandler(home);
var server = Bun.serve({ hostname: "127.0.0.1", port: requiredPort(), fetch: handler });
console.log(`Canonical Workbench Gateway ready on http://127.0.0.1:${server.port}`);
var stopping = false;
function stop() {
  if (stopping)
    return;
  stopping = true;
  server.stop(true);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
