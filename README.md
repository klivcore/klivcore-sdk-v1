# Klivcore SDK v1

The complete public repository for building and diagnosing an independent Klivcore Realm. External Realm code needs this repository only; it must not import Klivcore's app, Workbench, Agent, Chat, Voice, or internal Realm repositories.

## What the SDK owns

- Strict versioned Realm descriptor, route catalog, artifact, capability, and host ABI contracts.
- A bounded client that binds to a Realm Gateway and verifies catalog, JavaScript, and CSS integrity before activation.
- A small reference Realm Gateway with opaque per-process bindings and authorized publication reads.
- One conformance command shared by every Realm.

Repository generation (`klivcore-sdk-v1`) is separate from protocol/schema/host API versions (`1.0.0`).

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

The component JavaScript must be self-contained: no imports from private repositories and no package or app globals. It exports `mount(host)`, renders only into `host.root`, and may return an unmount function. CSS is mounted into the same ShadowRoot by the generic App Kernel.

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
- `GET /artifacts/home.js` and `/artifacts/home.css` — require the same binding.
- `GET /health` — basic process identity.

This proof uses cooperative endpoint authority and permissive CORS. Production authentication, tenant isolation, signing, sandboxing, and durable binding persistence are intentionally outside this first swappability milestone.
