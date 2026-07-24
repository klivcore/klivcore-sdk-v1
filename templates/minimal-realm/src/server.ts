import { mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadPublishedAppV2, resolvePublishedAppV2Root } from "@klivcore/sdk-v1/app-launcher";
import { createPasskeyAuth, createRealmGateway, type RealmGatewayConfig } from "@klivcore/sdk-v1/server";

const realmId = "example-realm";
const realmName = "Example Realm";
const port = Number(process.env.PORT ?? 47002);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535");

const publicOrigin = process.env.REALM_PUBLIC_ORIGIN;
if (!publicOrigin) throw new Error("REALM_PUBLIC_ORIGIN must be the exact public Realm origin");
const publicUrl = new URL(publicOrigin);
if (publicUrl.origin !== publicOrigin || publicUrl.username || publicUrl.password) {
  throw new Error("REALM_PUBLIC_ORIGIN must contain only an exact origin");
}

export const branding = Object.freeze({ canvasColor: "#101820" });
const databasePath = process.env.REALM_AUTH_DATABASE ?? resolve(import.meta.dir, "../data/auth.sqlite");
const publicationRoot = resolve(import.meta.dir, "../../klivcore-sdk-v1/app-v2");
const appV2 = await loadPublishedAppV2(await resolvePublishedAppV2Root(publicationRoot));
const auth = createPasskeyAuth({
  branding,
  databasePath,
  realmId,
  realmName,
  publicOrigin,
  rpId: publicUrl.hostname,
  allowInsecureLoopback: publicUrl.protocol === "http:"
    && (publicUrl.hostname === "127.0.0.1" || publicUrl.hostname === "localhost"),
});

const config = {
  branding,
  hostname: "127.0.0.1",
  port,
  realmId,
  name: realmName,
  authorityEpoch: "example-realm-1",
  generation: "example-realm-1",
  capabilities: ["realm:view"],
  publicBindingCapabilities: ["realm:view"],
  appV2,
  auth,
  defaultRoute: {
    id: "home",
    path: "/",
    title: "Example Home",
    requiredCapabilities: ["realm:view"],
    componentId: "example-home",
    js: "export function mount(host){host.root.innerHTML='<main><p>Example Realm</p><h1>Ready.</h1></main>';return ()=>host.root.replaceChildren()}",
    css: ":host{display:block;min-height:100%;background:#101820;color:#f7f3e8;font-family:Inter,ui-sans-serif,system-ui,sans-serif}main{box-sizing:border-box;min-height:100%;padding:clamp(3rem,9vw,7rem);display:grid;align-content:center}h1{font-size:clamp(3rem,8vw,7rem);margin:0}",
  },
} satisfies RealmGatewayConfig;

const gateway = createRealmGateway(config);
const registrationFile = process.env.REALM_REGISTRATION_FILE;
if (registrationFile) {
  const registrationPath = resolve(registrationFile);
  await mkdir(dirname(registrationPath), { recursive: true, mode: 0o700 });
  const output = await open(registrationPath, "wx", 0o600);
  let complete = false;
  try {
    await output.writeFile(`${gateway.issueRegistrationUrl()}\n`, "utf8");
    complete = true;
  } finally {
    await output.close();
    if (!complete) await rm(registrationPath, { force: true });
  }
  console.log(`Registration URL written to private file ${registrationPath}`);
}
console.log(`${realmName} listening at ${gateway.endpoint} for ${publicOrigin}`);
