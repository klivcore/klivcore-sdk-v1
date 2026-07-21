import { createRealmGateway } from "@klivcore/sdk-v1/server";

const gateway = createRealmGateway({
  hostname: "127.0.0.1", port: Number(process.env.PORT ?? 47001),
  realmId: "example", name: "Example Realm", authorityEpoch: "example-1", generation: "example-1",
  capabilities: ["realm:view", "example:inspect"],
  defaultRoute: {
    id: "home", path: "/", title: "Example Home", requiredCapabilities: ["realm:view"], componentId: "example-home",
    js: "export function mount(host){host.root.innerHTML='<main><h1>Example Realm</h1></main>';return ()=>host.root.replaceChildren()}",
    css: ":host{display:block;font-family:system-ui}main{padding:3rem}",
  },
});
console.log(`Example Realm listening at ${gateway.endpoint}`);
