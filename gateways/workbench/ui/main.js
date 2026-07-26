// packages/publish-sdk/src/gateway-contract.ts
var WORKBENCH_GATEWAY_MAX_BYTES = 1024 * 1024;
var WORKBENCH_GATEWAY_MAX_ELEMENTS = 1000;
var WORKBENCH_GATEWAY_MAX_EDGES = 2000;
var ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
var HEX = /^#[0-9a-fA-F]{6}$/u;
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

// packages/publish-sdk/src/gateway-ui-core.ts
function mountWorkbenchGateway(root, service) {
  let bench;
  let disposed = false;
  let selectedId;
  let saveGeneration = 0;
  const ready = (async () => {
    const response = await service.request("/v1/bench");
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Workbench load failed with ${response.status}`);
    }
    bench = parseGatewayBench(await response.json());
    if (!disposed)
      render();
  })();
  function render() {
    if (!bench || disposed)
      return;
    root.replaceChildren();
    root.className = "workbench-gateway";
    const header = element("header", "workbench-gateway__header");
    const title = element("div", "workbench-gateway__title");
    title.textContent = bench.name;
    const toolbar = element("div", "workbench-gateway__toolbar");
    for (const type of ["square", "rect", "text", "group"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = `add-${type}`;
      button.textContent = `+ ${type === "rect" ? "rectangle" : type}`;
      button.addEventListener("click", () => void add(type));
      toolbar.append(button);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.action = "delete-selected";
    remove.textContent = "Delete";
    remove.disabled = !selectedId;
    remove.addEventListener("click", () => void removeSelected());
    toolbar.append(remove);
    const status = element("span", "workbench-gateway__status");
    status.dataset.saveStatus = "idle";
    status.textContent = "Saved";
    header.append(title, toolbar, status);
    const viewport = element("div", "workbench-gateway__viewport");
    const canvas = element("div", "workbench-gateway__canvas");
    canvas.style.width = "1200px";
    canvas.style.height = "720px";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("workbench-gateway__edges");
    svg.setAttribute("viewBox", "0 0 1200 720");
    for (const edge of bench.edges)
      svg.append(renderEdge(edge, bench.elements));
    canvas.append(svg);
    for (const item of [...bench.elements].sort((a, b) => rank(a) - rank(b)))
      canvas.append(renderElement(item));
    viewport.append(canvas);
    root.append(header, viewport);
  }
  function renderElement(item) {
    const node = item.type === "text" ? document.createElement("article") : document.createElement("div");
    node.className = `workbench-gateway__element workbench-gateway__element--${item.type}${selectedId === item.id ? " is-selected" : ""}`;
    node.dataset.workbenchElementId = item.id;
    node.setAttribute("data-workbench-element-type", item.type);
    node.style.left = `${item.x}px`;
    node.style.top = `${item.y}px`;
    node.style.width = `${item.type === "square" ? item.size : item.width}px`;
    node.style.height = `${item.type === "square" ? item.size : item.height}px`;
    if (item.type === "square") {
      node.dataset.color = item.color;
      node.textContent = item.color;
    }
    if (item.type === "rect")
      node.style.backgroundColor = item.color;
    if (item.type === "group") {
      const label = element("strong", "workbench-gateway__group-label");
      label.textContent = item.label;
      node.append(label);
    }
    if (item.type === "text") {
      const textarea = document.createElement("textarea");
      textarea.value = item.value;
      textarea.setAttribute("aria-label", "Workbench text");
      textarea.addEventListener("pointerdown", (event) => event.stopPropagation());
      textarea.addEventListener("input", () => updateElement(item.id, { value: textarea.value }, false));
      textarea.addEventListener("change", () => void save());
      node.append(textarea);
    }
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      selectedId = item.id;
      render();
    });
    node.addEventListener("pointerdown", (event) => beginDrag(event, item.id));
    return node;
  }
  function beginDrag(event, id) {
    if (event.target.tagName === "TEXTAREA" || !bench)
      return;
    event.preventDefault();
    selectedId = id;
    const original = bench.elements.find((candidate) => candidate.id === id);
    if (!original)
      return;
    const startX = event.clientX;
    const startY = event.clientY;
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const move = (next) => updateElement(id, { x: Math.round(original.x + next.clientX - startX), y: Math.round(original.y + next.clientY - startY) }, true);
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      save();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end, { once: true });
    target.addEventListener("pointercancel", end, { once: true });
    render();
  }
  function updateElement(id, patch, rerender) {
    if (!bench)
      return;
    bench = parseGatewayBench({ ...bench, elements: bench.elements.map((item) => item.id === id ? { ...item, ...patch } : item) });
    if (rerender)
      render();
  }
  async function add(type) {
    if (!bench)
      return;
    const id = `${type}:${createId()}`;
    const offset = bench.elements.length * 18;
    const common = { id, type, x: 120 + offset, y: 110 + offset };
    const item = type === "square" ? { ...common, type, color: "blue", size: 120 } : type === "rect" ? { ...common, type, color: "#22c55e", width: 220, height: 140 } : type === "text" ? { ...common, type, value: "New text", width: 260, height: 160 } : { ...common, type, label: "New group", width: 520, height: 360 };
    bench = parseGatewayBench({ ...bench, elements: [...bench.elements, item] });
    selectedId = id;
    render();
    await save();
  }
  async function removeSelected() {
    if (!bench || !selectedId)
      return;
    const removed = selectedId;
    const removedIds = new Set([removed, ...bench.elements.filter((item) => item.parentId === removed).map((item) => item.id)]);
    bench = parseGatewayBench({
      ...bench,
      elements: bench.elements.filter((item) => !removedIds.has(item.id)),
      edges: bench.edges.filter((edge) => !removedIds.has(edge.from.elementId) && !removedIds.has(edge.to.elementId))
    });
    selectedId = undefined;
    render();
    await save();
  }
  async function save() {
    if (!bench || disposed)
      return;
    const generation = ++saveGeneration;
    const status = root.querySelector("[data-save-status]");
    if (status) {
      status.dataset.saveStatus = "saving";
      status.textContent = "Saving…";
    }
    const response = await service.request("/v1/bench", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bench) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Workbench save failed with ${response.status}`);
    }
    bench = parseGatewayBench(await response.json());
    if (generation === saveGeneration && !disposed) {
      const current = root.querySelector("[data-save-status]");
      if (current) {
        current.dataset.saveStatus = "saved";
        current.textContent = "Saved";
      }
    }
  }
  return Object.freeze({ ready, unmount() {
    disposed = true;
    root.replaceChildren();
    root.className = "";
  } });
}
function renderEdge(edge, elements) {
  const from = elements.find((element) => element.id === edge.from.elementId);
  const to = elements.find((element) => element.id === edge.to.elementId);
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.dataset.workbenchEdge = edge.id;
  if (from && to) {
    const a = center(from);
    const b = center(to);
    line.setAttribute("x1", String(a.x));
    line.setAttribute("y1", String(a.y));
    line.setAttribute("x2", String(b.x));
    line.setAttribute("y2", String(b.y));
  }
  line.setAttribute("stroke", edge.color ?? "#94a3b8");
  line.setAttribute("stroke-width", "3");
  return line;
}
function center(element) {
  const width = element.type === "square" ? element.size : element.width;
  const height = element.type === "square" ? element.size : element.height;
  return { x: element.x + width / 2, y: element.y + height / 2 };
}
function rank(element) {
  return element.type === "group" ? 0 : 1;
}
function element(tag, className) {
  const value = document.createElement(tag);
  value.className = className;
  return value;
}
function createId() {
  return globalThis.crypto?.randomUUID?.().slice(0, 12) ?? Math.random().toString(36).slice(2, 14);
}

// packages/publish-sdk/src/gateway-ui.ts
function mount(host) {
  const service = host.services.api;
  if (!service)
    throw new Error("Workbench API service is unavailable");
  const mounted = mountWorkbenchGateway(host.root, service);
  mounted.ready.catch((error) => {
    host.root.replaceChildren();
    const message = document.createElement("p");
    message.className = "workbench-gateway__error";
    message.textContent = error instanceof Error ? error.message : "Workbench failed to load";
    host.root.append(message);
  });
  return () => mounted.unmount();
}
export {
  mount
};
