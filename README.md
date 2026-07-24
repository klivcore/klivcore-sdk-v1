# Klivcore SDK v1

This generated repository is the complete public boundary for building and operating an independent Klivcore Realm. External Realm agents use only this repository: its documentation, templates, exports, tests, and published App V2 assets. They must not inspect Klivcore's private source repositories.

## External-agent acceptance rule

The SDK is incomplete if an external agent needs private instructions to configure or operate a Realm. Using this repository alone, an agent must be able to:

1. create a Realm from `templates/minimal-realm`;
2. choose and apply bounded Realm branding;
3. configure the exact browser-visible origin used by WebAuthn;
4. start a private loopback Realm and its public HTTPS tunnel in the correct order;
5. issue short-lived single-use registration URLs for multiple users without persisting plaintext capability material;
6. run tests, build, conformance, and public deployment checks;
7. connect system OpenSSH through the authenticated HTTPS Realm relay without a public SSH port;
8. diagnose failures at the Realm, tunnel, authentication, relay, and publication boundaries.

## One-command fresh-server Realm

On a fresh Linux x64 or arm64 host with only Bun and `config.json`, run the SDK directly from GitHub:

```bash
bunx --package https://github.com/Klivcore/klivcore-sdk-v1 start-realm config.json
```

Start from `examples/start-realm.config.json`. The command:

1. validates the strict configuration;
2. creates a private durable state directory;
3. downloads the pinned `cloudflared` binary and verifies its published SHA-256 digest;
4. starts Quick Tunnel first and captures its generated HTTPS origin;
5. loads the integrity-checked App V2 and starts the authenticated Realm on `127.0.0.1` with that exact origin;
6. verifies local and public `/health` responses identify the configured Realm;
7. writes a mode-`0600` active-runtime record containing the verified origins, process identity, and a random runtime-scoped registration-control capability;
8. prints the safe Realm URL, registration command, and whether authenticated **Connect Desktop** pairing is enabled.

The foreground command owns both processes. Keep it running with your host's ordinary process supervisor; `Ctrl-C` stops the Realm and tunnel together. Quick Tunnel is an ephemeral onboarding endpoint: a later run may produce a different origin and therefore require a new passkey registration. Use a named tunnel and stable DNS for durable deployments.

### Give a user a registration URL

While the Realm is running, an operating agent generates a fresh registration URL with:

```bash
bunx --package https://github.com/Klivcore/klivcore-sdk-v1 \
  start-realm registration-url config.json
```

The command verifies the private active-runtime record, running process, exact local Realm identity, and exact public Realm identity. It then authenticates a local POST with the runtime-scoped control capability. The exact live Realm—not the command process—creates the grant and returns the URL. A stopped or replacement process cannot issue from a stale record because it does not hold the matching capability in memory. The active record is sensitive host-local state: never log or copy it, and let the launcher remove it during shutdown. The command prints one URL and exits. The URL:

- expires after five minutes;
- is valid for one successful passkey registration;
- represents a distinct human credential for this Realm;
- is stored only as a SHA-256 hash in the Realm database;
- has its grant and registration ceremony physically deleted in the same transaction that saves the credential;
- does not invalidate other users' outstanding registration URLs.

When the user explicitly asks for a registration URL, the agent runs this command and returns the exact output only in that private conversation. The agent must not place the URL in logs, issues, commits, summaries, memory, or public channels. Generate a new URL for every user; never reuse one. Expired grants are rejected and physically removed. Normal Realm startup never generates a registration URL.

### Connect Hermes Desktop through the Realm

Configure `desktop.ssh` with the fixed private SSH target reachable by the Realm process. For an EC2 instance hosting its own Realm, use `127.0.0.1`, port `22`, the ordinary SSH user, and the absolute Realm working directory. Do not put passwords, private keys, public tunnel URLs, or shell commands in the config.

After passkey sign-in, choose **Connect Desktop** in the Realm menu. It copies a command containing a five-minute one-use pairing capability. Run that command on the machine containing Hermes Desktop. The command consumes the capability, creates a mode-`0600` relay profile, and installs a managed `~/.ssh/config` host named `klivcore-<realm-id>`. The helper authenticates a WSS connection through the existing Quick Tunnel; the Realm Gateway then connects only to its configured private SSH target.

OpenSSH authentication and host-key verification remain end to end. The Realm relay credential authorizes only transport to the configured SSH service; it is not an administrator credential and does not replace the user's SSH key or agent. The private target is never returned to the browser or Desktop client.

## Install and verify the SDK

Use a clean checkout or a pinned release of this generated repository. Do not hand-edit generated SDK files.

```bash
bun install
bun test
bun run build
```

The repository includes the integrity-checked generic App V2 under `app-v2/` and Realm-owned public contracts under `src/`.

## Create a Realm

Copy the complete template into a new repository next to the SDK checkout:

```bash
cp -R klivcore-sdk-v1/templates/minimal-realm example-realm-v1
cd example-realm-v1
bun install
bun test
bun run build
```

The template depends only on the sibling SDK:

```json
"@klivcore/sdk-v1": "file:../klivcore-sdk-v1"
```

Customize the Realm ID, name, authority epoch, generation, capabilities, route, and self-contained component bytes in `src/server.ts`. Realm component JavaScript must have no private imports or application globals. It exports `mount(host)`, renders only into `host.root`, and may return an unmount function.

## Realm branding

`RealmBranding` is a bounded public contract with exactly one field:

```ts
const branding = Object.freeze({
  canvasColor: "#101820",
});
```

`canvasColor` must be a lowercase six-digit hexadecimal color. Pass the same object to both `createPasskeyAuth({ branding, ... })` and `createRealmGateway({ branding, ... })`. The SDK applies it to:

- the passkey registration and login document;
- the HTML `theme-color` marker;
- the generic App V2 startup canvas;
- authenticated App rendering.

Do not independently hardcode these surfaces. One Realm-owned value is the branding source.

## Exact-origin authentication

Realm passkeys are scoped to the exact browser-visible origin. Configure it with `REALM_PUBLIC_ORIGIN`:

```bash
REALM_PUBLIC_ORIGIN=https://realm.example.com bun run dev
```

The value must be an origin only: scheme, hostname, and optional port, with no path, query, fragment, username, or password. For public deployments it must be HTTPS. The WebAuthn RP ID is the origin hostname.

The template configures:

```ts
createPasskeyAuth({
  branding,
  databasePath,
  realmId,
  realmName,
  publicOrigin,
  rpId: new URL(publicOrigin).hostname,
});
```

The gateway always binds to loopback. Authentication state belongs to the Realm and is persisted in its own SQLite database. Never share the database, cookies, registration URLs, passkeys, or session material across Realms.

## Quick Tunnel startup order

A Cloudflare Quick Tunnel URL is ephemeral. The Realm cannot know its exact WebAuthn origin until Cloudflare creates the tunnel, so startup order is mandatory:

1. choose the private loopback port;
2. start `cloudflared` for that fixed port;
3. read the generated `https://*.trycloudflare.com` origin from local tunnel output;
4. start the Realm with that exact value as `REALM_PUBLIC_ORIGIN`;
5. supervise the tunnel and Realm as separate named processes;
6. verify the private listener and public route before reporting success.

Example tunnel command:

```bash
cloudflared tunnel --url http://127.0.0.1:47002
```

Then start the Realm in a separate supervisor using the generated origin:

```bash
REALM_PUBLIC_ORIGIN=https://generated-name.trycloudflare.com \
PORT=47002 \
bun run dev
```

Do not start the Realm with a guessed origin, a stale Quick Tunnel URL, or only `PORT`. Do not treat `Registered tunnel connection` as deployment success: Cloudflare can be connected while the loopback origin is absent, which produces HTTP 502.

A production launcher should capture the generated origin, pass it directly to the Realm process, preserve both process identities, and stop or restart only the failed component. It must not expose the loopback gateway on `0.0.0.0` merely to make the tunnel work.

## Template passkey registration

The standalone template never prints registration capability material. To request a registration URL, provide a new private output path:

```bash
REALM_PUBLIC_ORIGIN=https://generated-name.trycloudflare.com \
REALM_REGISTRATION_FILE="$HOME/.local/state/example-realm/registration-url" \
bun run dev
```

The server creates that file once with mode `0600`. Deliver the URL privately to the intended human, complete registration within five minutes, then delete the file. The URL is single-use and its database grant is deleted immediately after successful registration. A later run with a new output path can issue a separate URL for another user. Do not put the URL in logs, source control, shell history, monitoring events, summaries, or memory.

Omit `REALM_REGISTRATION_FILE` during normal startup.

## Public deployment acceptance checks

A deployment is working only when every boundary passes:

```text
private listener   127.0.0.1:<port> is listening
private health     GET /health returns 200 and the expected Realm ID
public root        redirects to /auth/login when unauthenticated
public login       GET /auth/login returns 200
branding           login HTML has the expected theme-color and auth shell
anonymous catalog  GET /v1/catalog returns 401
wrong origin       POST /v1/bind from another Origin returns 403
tunnel process     remains connected to the fixed loopback port
browser console    has no uncaught JavaScript errors
```

For a Quick Tunnel, test the exact generated URL—not an older URL remembered from another run. A `502` with a connected tunnel means the Realm listener is absent or the tunnel targets the wrong port.

Run the Realm's tests and build before restarting it. Restart only the Realm process when code changes; preserve a healthy independent tunnel so its generated origin remains valid.

## Self-hosted App V2

Load the SDK's immutable App V2 publication and pass it to the Gateway:

```ts
const appV2 = await loadPublishedAppV2(
  await resolvePublishedAppV2Root(publicationRoot),
);

createRealmGateway({
  branding,
  appV2,
  auth,
  // Realm identity, capabilities, routes, and services
});
```

The generic App owns no Realm identity or endpoint. One browser origin hosts one Realm, and each Realm owns its authentication and sessions.

## Routes, capabilities, and services

`RealmGatewayConfig.routes` publishes exact non-default paths. Every route owns an ID, path, required capabilities, component ID, and self-contained JavaScript/CSS bytes.

`RealmGatewayConfig.services` adds authenticated bounded HTTP/WebSocket services. Each service declares required capabilities, allowed methods/paths, and limits. `publicBindingCapabilities` must contain viewer capabilities only. Fixed virtual-port relays use server-owned upstream origins and exact request rules; browser input must never select arbitrary hosts, ports, methods, or upstream credentials.

## Diagnosis

Diagnose each boundary separately:

- startup exception: read the complete error; required configuration is missing or invalid;
- no private listener: Realm process exited or bound the wrong port;
- public 502: tunnel is connected but cannot reach its fixed loopback origin;
- login is unstyled: consumer is using an outdated SDK publication or omitted branding;
- WebAuthn origin/RP failure: `REALM_PUBLIC_ORIGIN` does not exactly match the browser origin;
- anonymous 401: expected for protected SDK surfaces;
- wrong-origin 403: expected exact-origin enforcement;
- integrity failure: published App, catalog, or artifact bytes do not match their manifest/hash.

Never solve an SDK gap by importing private Klivcore repositories. Report the missing public contract or documentation to the owning publisher, republish the SDK, then retry from the public boundary.
