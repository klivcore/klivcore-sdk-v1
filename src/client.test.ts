import { describe, expect, test } from "bun:test";
import { bindAndPrepareRealm, sha256Hex, type RealmFetcher } from "./client";

function json(value: unknown) {
  return JSON.stringify(value);
}

async function fixture() {
  const js = "export function mount(host){host.root.textContent='Realm publication';return ()=>host.root.replaceChildren()}";
  const css = ":host{display:block}";
  const catalog = {
    schemaVersion: "1.0.0",
    realmId: "development",
    generation: "development-1",
    defaultRouteId: "home",
    routes: [{
      id: "home",
      path: "/",
      title: "Home",
      requiredCapabilities: ["realm:view"],
      component: {
        id: "development-home",
        hostApiRange: "^1.0.0",
        js: { url: "https://realm.test/artifacts/home.js", sha256: await sha256Hex(js), mediaType: "text/javascript" },
        css: { url: "https://realm.test/artifacts/home.css", sha256: await sha256Hex(css), mediaType: "text/css" },
      },
    }],
  };
  const catalogText = json(catalog);
  const descriptor = {
    protocolVersion: "1.0.0",
    realmId: "development",
    name: "Development Realm",
    authority: { bindingId: "binding-123", epoch: "dev-1" },
    publication: {
      catalogUrl: "https://realm.test/v1/catalog",
      catalogSha256: await sha256Hex(catalogText),
      generation: "development-1",
      hostApiRange: "^1.0.0",
    },
    capabilities: ["realm:view", "development:inspect"],
  };
  return { catalogText, css, descriptor, js };
}

describe("Realm client", () => {
  test("binds and prepares verified JS/CSS before returning a candidate", async () => {
    const f = await fixture();
    const requests: string[] = [];
    const fetcher: RealmFetcher = async function(this: typeof globalThis, input, init) {
      expect(this).toBe(globalThis);
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/v1/bind")) return new Response(json(f.descriptor), { headers: { "content-type": "application/json" } });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer binding-123");
      if (url.endsWith("/v1/catalog")) return new Response(f.catalogText, { headers: { "content-type": "application/json" } });
      if (url.endsWith("home.js")) return new Response(f.js, { headers: { "content-type": "text/javascript" } });
      if (url.endsWith("home.css")) return new Response(f.css, { headers: { "content-type": "text/css" } });
      return new Response("not found", { status: 404 });
    };

    const prepared = await bindAndPrepareRealm("https://realm.test", { fetcher });
    expect(prepared.descriptor.realmId).toBe("development");
    expect(prepared.route.id).toBe("home");
    expect(prepared.js).toContain("export function mount");
    expect(requests).toEqual([
      "https://realm.test/v1/bind",
      "https://realm.test/v1/catalog",
      "https://realm.test/artifacts/home.js",
      "https://realm.test/artifacts/home.css",
    ]);
  });

  test("fails closed when an artifact hash is invalid", async () => {
    const f = await fixture();
    const fetcher: RealmFetcher = async function(this: typeof globalThis, input) {
      const url = String(input);
      if (url.endsWith("/v1/bind")) return new Response(json(f.descriptor), { headers: { "content-type": "application/json" } });
      if (url.endsWith("/v1/catalog")) return new Response(f.catalogText, { headers: { "content-type": "application/json" } });
      if (url.endsWith("home.js")) return new Response("tampered", { headers: { "content-type": "text/javascript" } });
      return new Response(f.css, { headers: { "content-type": "text/css" } });
    };
    await expect(bindAndPrepareRealm("https://realm.test", { fetcher })).rejects.toThrow("integrity");
  });
});
