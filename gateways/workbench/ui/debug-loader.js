// packages/publish-sdk/src/gateway-debug-loader.ts
var DEBUG_ROUTE = /(?:^|\/)debug\/([a-z0-9][a-z0-9-]{0,127})\/([a-z0-9][a-z0-9-]{0,127})$/u;
var MAX_JAVASCRIPT_BYTES = 16 * 1024 * 1024;
var MAX_CSS_BYTES = 4 * 1024 * 1024;
async function boundedText(response, maximum, label) {
  if (!response.ok)
    throw new Error(`${label} request failed (${response.status})`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw new Error(`${label} exceeds its byte limit`);
  }
  if (!response.body)
    return "";
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      byteLength += value.byteLength;
      if (byteLength > maximum) {
        await reader.cancel().catch(() => {
          return;
        });
        throw new Error(`${label} exceeds its byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function mount(host) {
  const service = host.services.api;
  if (!service)
    throw new Error("Workbench debug service is unavailable");
  const match = DEBUG_ROUTE.exec(globalThis.location.pathname);
  if (!match)
    throw new Error("Workbench debug route is invalid");
  const [, categoryId, scenarioId] = match;
  const componentHref = globalThis.location.pathname.slice(0, -scenarioId.length - 1);
  const componentName = categoryId.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
  const status = host.root.ownerDocument.createElement("main");
  status.setAttribute("data-workbench-debug-loader", "loading");
  status.textContent = "Loading Workbench debug scenario…";
  host.root.append(status);
  let disposed = false;
  let scenarioCleanup;
  let moduleUrl;
  let style;
  try {
    const [javascriptResponse, cssResponse] = await Promise.all([
      service.request(`/v1/debug/assets/${categoryId}.js`),
      service.request(`/v1/debug/assets/${categoryId}.css`)
    ]);
    const [javascript, css] = await Promise.all([
      boundedText(javascriptResponse, MAX_JAVASCRIPT_BYTES, "Workbench debug JavaScript"),
      boundedText(cssResponse, MAX_CSS_BYTES, "Workbench debug CSS")
    ]);
    if (disposed)
      return () => {};
    style = host.root.ownerDocument.createElement("style");
    style.textContent = css;
    host.root.append(style);
    moduleUrl = URL.createObjectURL(new Blob([javascript], { type: "text/javascript" }));
    const debugModule = await import(moduleUrl);
    if (!debugModule || typeof debugModule.mountDebugScenario !== "function")
      throw new Error("Workbench debug category is invalid");
    const cleanup = await debugModule.mountDebugScenario(host, scenarioId, { componentHref, componentName });
    if (cleanup !== undefined && typeof cleanup !== "function")
      throw new Error("Workbench debug scenario returned an invalid cleanup");
    if (typeof cleanup === "function")
      scenarioCleanup = cleanup;
    status.remove();
  } catch (error) {
    console.error("Workbench debug scenario failed to load", error);
    status.setAttribute("data-workbench-debug-loader", "error");
    status.textContent = error instanceof Error ? error.message : "Workbench debug scenario failed to load";
  } finally {
    if (moduleUrl)
      URL.revokeObjectURL(moduleUrl);
  }
  return () => {
    disposed = true;
    try {
      scenarioCleanup?.();
    } finally {
      style?.remove();
      status.remove();
    }
  };
}
export {
  mount
};
