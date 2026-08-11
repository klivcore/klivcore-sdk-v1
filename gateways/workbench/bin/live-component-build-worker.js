// @bun
// packages/bench-gateway-server/src/source-build-worker.ts
import { createHash } from "crypto";

// packages/bench-gateway-server/src/source-build-runner.ts
var MAX_SOURCE_BYTES = 512 * 1024;
var MAX_WORKER_RESPONSE_BYTES = 6 * 1024 * 1024;
var MAX_WORKER_STDERR_BYTES = 16 * 1024;
var MAX_JAVASCRIPT_BYTES = 2 * 1024 * 1024;
var MAX_CSS_BYTES = 512 * 1024;
var encoder = new TextEncoder;

// packages/bench-gateway-server/src/source-build-worker.ts
var MAX_JAVASCRIPT_BYTES2 = 2 * 1024 * 1024;
var MAX_CSS_BYTES2 = 512 * 1024;
var encoder2 = new TextEncoder;
var decoder = new TextDecoder("utf-8", { fatal: true });
var TYPE_ID = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/u;
try {
  const request = parseRequest(await readBoundedStdin());
  const result = await build(request);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  const message = sanitizeDiagnostic(error);
  process.stdout.write(JSON.stringify({ error: message }));
}
async function readBoundedStdin() {
  const reader = Bun.stdin.stream().getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done)
      break;
    total += result.value.byteLength;
    if (total > MAX_SOURCE_BYTES + 1024)
      throw new Error("request exceeded the supported bound");
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(bytes);
}
function parseRequest(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("request is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("request is malformed");
  const candidate = value;
  if (Object.keys(candidate).sort().join("\x00") !== ["sourceText", "typeId"].sort().join("\x00") || typeof candidate.sourceText !== "string" || encoder2.encode(candidate.sourceText).byteLength > MAX_SOURCE_BYTES || typeof candidate.typeId !== "string" || !TYPE_ID.test(candidate.typeId))
    throw new Error("request is malformed");
  return Object.freeze({ sourceText: candidate.sourceText, typeId: candidate.typeId });
}
async function build(request) {
  const approvedImports = new Set(["react", "react/jsx-runtime", "react/jsx-dev-runtime"]);
  const imports = new Bun.Transpiler({ loader: "tsx" }).scanImports(request.sourceText);
  const rejectedImport = imports.find((candidate) => !approvedImports.has(candidate.path));
  if (rejectedImport)
    throw new Error(`Import is not allowed: ${rejectedImport.path.slice(0, 160)}`);
  const result = await Bun.build({
    entrypoints: ["klivcore:component-entry"],
    format: "esm",
    minify: false,
    plugins: [componentPlugin(request)],
    splitting: false,
    sourcemap: "none",
    target: "browser",
    write: false
  });
  if (!result.success)
    throw new Error(result.logs.map((log) => log.message).join("; ") || "compiler rejected source");
  const javascript = result.outputs.find((output) => output.kind === "entry-point");
  if (!javascript)
    throw new Error("compiler produced no JavaScript");
  const css = result.outputs.find((output) => output.path.endsWith(".css"));
  const rawJs = new Uint8Array(await javascript.arrayBuffer());
  const rawCss = css ? new Uint8Array(await css.arrayBuffer()) : undefined;
  if (rawJs.byteLength > MAX_JAVASCRIPT_BYTES2 || (rawCss?.byteLength ?? 0) > MAX_CSS_BYTES2)
    throw new Error("artifact exceeded the supported bound");
  const jsSha = sha256(rawJs);
  const cssSha = rawCss ? sha256(rawCss) : undefined;
  const implementationRevision = sha256(encoder2.encode(`${jsSha}:${cssSha ?? ""}`));
  const revisionedJs = encoder2.encode(new TextDecoder().decode(rawJs).replaceAll("__KLIVCORE_IMPLEMENTATION_REVISION__", implementationRevision));
  const manifest = `/*klivcore-manifest:${JSON.stringify({ components: [{ implementationRevision, renderMode: "element", typeId: request.typeId }] })}*/
`;
  const jsBytes = concat(encoder2.encode(manifest), revisionedJs);
  if (jsBytes.byteLength > MAX_JAVASCRIPT_BYTES2)
    throw new Error("artifact exceeded the supported bound");
  const finalJsSha = sha256(jsBytes);
  return Object.freeze({
    artifacts: Object.freeze([
      Object.freeze({ bytesBase64: Buffer.from(jsBytes).toString("base64"), kind: "js", sha256: finalJsSha }),
      ...rawCss && cssSha ? [Object.freeze({ bytesBase64: Buffer.from(rawCss).toString("base64"), kind: "css", sha256: cssSha })] : []
    ]),
    ...cssSha ? { cssArtifactSha256: cssSha } : {},
    implementationRevision,
    jsArtifactSha256: finalJsSha,
    sourceRevision: implementationRevision,
    typeId: request.typeId
  });
}
function componentPlugin(request) {
  return {
    name: "klivcore-source-component",
    setup(builder) {
      builder.onResolve({ filter: /^klivcore:component-entry$/ }, () => ({ namespace: "klivcore-entry", path: "entry" }));
      builder.onLoad({ filter: /^entry$/, namespace: "klivcore-entry" }, () => ({
        contents: `import Component from "klivcore:component-source";
export const components = Object.freeze([Object.freeze({ implementationRevision: "__KLIVCORE_IMPLEMENTATION_REVISION__", renderMode: "element", typeId: ${JSON.stringify(request.typeId)}, render(host, resolved) { return host.createElement(Component, resolved); } })]);
`,
        loader: "js"
      }));
      builder.onResolve({ filter: /^klivcore:component-source$/ }, () => ({ namespace: "klivcore-source", path: "source.tsx" }));
      builder.onLoad({ filter: /^source\.tsx$/, namespace: "klivcore-source" }, () => ({ contents: request.sourceText, loader: "tsx" }));
      for (const specifier of ["react", "react/jsx-runtime", "react/jsx-dev-runtime"]) {
        builder.onResolve({ filter: new RegExp(`^${specifier.replace("/", "\\/")}$`, "u") }, () => ({ namespace: "klivcore-react", path: specifier }));
      }
      builder.onLoad({ filter: /^react$/, namespace: "klivcore-react" }, () => ({ contents: reactBridgeSource(), loader: "js" }));
      builder.onLoad({ filter: /^react\/jsx-(?:dev-)?runtime$/, namespace: "klivcore-react" }, () => ({ contents: jsxBridgeSource(), loader: "js" }));
      builder.onResolve({ filter: /.*/ }, (args) => ({ errors: [{ text: `Import is not allowed: ${args.path.slice(0, 160)}` }] }));
    }
  };
}
function sanitizeDiagnostic(error) {
  const raw = error instanceof Error ? error.message : "compiler failed";
  return raw.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s:;,)]+/gu, "<redacted>").replace(/[\r\n\t]+/gu, " ").slice(0, 1024) || "compiler failed";
}
function reactBridgeSource() {
  const names = ["Activity", "Children", "Component", "Fragment", "Profiler", "PureComponent", "StrictMode", "Suspense", "act", "cache", "cacheSignal", "captureOwnerStack", "cloneElement", "createContext", "createElement", "createRef", "experimental_useEffectEvent", "forwardRef", "isValidElement", "lazy", "memo", "startTransition", "unstable_useCacheRefresh", "use", "useActionState", "useCallback", "useContext", "useDebugValue", "useDeferredValue", "useEffect", "useEffectEvent", "useId", "useImperativeHandle", "useInsertionEffect", "useLayoutEffect", "useMemo", "useOptimistic", "useReducer", "useRef", "useState", "useSyncExternalStore", "useTransition", "version"];
  return `const React = globalThis[Symbol.for("klivcore.workbench.react")].React;
export default React;
${names.map((name) => `export const ${name} = React.${name};`).join(`
`)}
`;
}
function jsxBridgeSource() {
  return `const runtime = globalThis[Symbol.for("klivcore.workbench.react")].jsxRuntime;
export const Fragment = runtime.Fragment;
export const jsx = runtime.jsx;
export const jsxs = runtime.jsxs;
export const jsxDEV = runtime.jsxDEV;
`;
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function concat(left, right) {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}
