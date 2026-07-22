# Klivcore SDK v1

The complete public repository for building and diagnosing an independent Klivcore Realm. External Realm code needs this repository only; it must not import Klivcore's app, Workbench, Agent, Chat, Voice, or internal Realm repositories.

## What the SDK owns

- Strict versioned Realm descriptor, route catalog, artifact, capability, and host ABI contracts.
- A bounded client that binds to a Realm Gateway, selects an authorized route, and verifies catalog, JavaScript, and CSS integrity before activation.
- A small reference Realm Gateway with opaque per-process bindings, authorized publication reads, and bounded authority-neutral service extension points.
- One conformance command shared by every Realm.

Repository generation (`klivcore-sdk-v1`) is separate from protocol and schema version `1.0.0` and host API version `1.2.0`.

## Build and test

```bash
bun install
bun test
bun run build
```

## Build a Realm

Copy `templates/minimal-realm` into a new repository next to this SDK snapshot. Keep the dependency as a local complete-repository dependency:

```json
"@klivcore/sdk-v1": "file:../klivcore-sdk-v1"
```

Customize only the values and self-contained component bytes in `src/server.ts`, then run:

```bash
bun install
bun test
bun run build
bun run dev
```

The component JavaScript must be self-contained: no imports from private repositories and no package or app globals. It exports `mount(host)`, renders only into `host.root`, and may return an unmount function. CSS is mounted into the same ShadowRoot by the generic App Kernel. `host.navigate(path)` requests a verified Realm route, while `host.setBadge(count)` publishes a bounded `0..999` unread count for that Realm. The reference Gateway shares the count across bindings and streams bounded `{ realmId, revision, count }` changes over an authenticated `/v1/notifications` WebSocket; clients must never aggregate counts across Realms. Badge writes still stage transactionally, so failed candidates cannot replace the active Realm's count.

Add non-default publications through the optional `routes` array on `RealmGatewayConfig`. Every route owns an ID, exact path, required capabilities, component ID, and self-contained JS/CSS bytes. Consumers select one exact published path with:

```ts
await bindAndPrepareRealm(endpoint, { routePath: "/debug/routing/basic" });
```

Omit `routePath` to select `defaultRoute`.

Realm-owned capabilities can add authenticated HTTP/WebSocket services through `RealmGatewayConfig.services`. Each service declares `requiredCapabilities`; the SDK enforces them for HTTP and WebSocket access in addition to binding authentication, path/message bounds, CORS, and socket cleanup. `publicBindingCapabilities` should contain only viewer capabilities. Realm-owned authentication can mint and later revoke a scoped producer grant with `issueBinding(...)` and `revokeBinding(...)`. Public and trusted binding pools are independently bounded, so public churn cannot evict trusted producers. Service packages own their domain protocol. For example, `@klivcore/resource-monitor-v1` supplies a per-Realm Monitor Gateway at `/v1/events` without making the SDK or App depend on monitoring.

## Conformance and diagnosis

With the Realm running:

```bash
bun run conformance http://127.0.0.1:47001
```

A successful report proves that the endpoint can issue an opaque binding; the descriptor and catalog are strict and compatible; the default route is authorized; and exact JS/CSS bytes match their SHA-256 references. Failures are deliberately closed:

- `request failed`: endpoint is unreachable or returned an error;
- `incompatible ... version/range`: protocol, schema, or host ABI differs;
- `integrity check failed`: catalog or artifact bytes differ from the advertised hash;
- `authority mismatch` / `not authorized`: Realm identity, generation, or capabilities are inconsistent;
- `unknown field`: a producer changed the wire contract without a new negotiated version.

## HTTP surface

- `POST /v1/bind` — returns a strict descriptor and opaque binding ID.
- `GET /v1/catalog` — requires `Authorization: Bearer <binding>`.
- `GET /artifacts/<route-id>.js` and `/artifacts/<route-id>.css` — route-specific bytes requiring the same binding.
- `GET /health` — basic process identity.

This proof uses cooperative endpoint authority and permissive CORS. The SDK enforces scoped grants, but a production Realm must authenticate or explicitly authorize callers before distributing a trusted grant. Tenant isolation, signing, sandboxing, and durable binding persistence remain outside this first swappability milestone.
