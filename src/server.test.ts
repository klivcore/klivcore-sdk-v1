import { afterEach, describe, expect, test } from "bun:test";
import { bindAndPrepareRealm } from "./client";
import { createRealmGateway, type RunningRealmGateway } from "./server";

const running: RunningRealmGateway[] = [];
afterEach(() => {
  for (const gateway of running.splice(0)) gateway.stop();
});

function start() {
  const gateway = createRealmGateway({
    hostname: "127.0.0.1",
    port: 0,
    realmId: "test-realm",
    name: "Test Realm",
    authorityEpoch: "test-1",
    generation: "test-1",
    capabilities: ["realm:view", "test:inspect"],
    defaultRoute: {
      id: "home",
      path: "/",
      title: "Test Home",
      requiredCapabilities: ["realm:view"],
      componentId: "test-home",
      js: "export function mount(host){host.root.textContent='Test Realm'}",
      css: ":host{color:rebeccapurple}",
    },
    routes: [{
      id: "debug-routing-basic",
      path: "/debug/routing/basic",
      title: "Routing debug",
      requiredCapabilities: ["test:inspect"],
      componentId: "test-debug-routing-basic",
      js: "export function mount(host){host.root.textContent='Debug route reached'}",
      css: ":host{color:lime}",
    }],
  });
  running.push(gateway);
  return gateway;
}

describe("reference Realm Gateway", () => {
  test("publishes a bind-authorized, integrity-verifiable Realm", async () => {
    const gateway = start();
    const candidate = await bindAndPrepareRealm(gateway.endpoint);
    expect(candidate.descriptor.realmId).toBe("test-realm");
    expect(candidate.descriptor.capabilities).toContain("test:inspect");
    expect(candidate.js).toContain("Test Realm");
  });

  test("rejects publication reads without the opaque binding", async () => {
    const gateway = start();
    const response = await fetch(`${gateway.endpoint}/v1/catalog`);
    expect(response.status).toBe(401);
  });

  test("selects and verifies a published debug route by path", async () => {
    const gateway = start();
    const candidate = await bindAndPrepareRealm(gateway.endpoint, { routePath: "/debug/routing/basic" });

    expect(candidate.catalog.routes.map((route) => route.path)).toEqual(["/", "/debug/routing/basic"]);
    expect(candidate.route.id).toBe("debug-routing-basic");
    expect(candidate.route.component.id).toBe("test-debug-routing-basic");
    expect(candidate.js).toContain("Debug route reached");
    expect(candidate.css).toContain("lime");
  });

  test("rejects a route path that the Realm did not publish", async () => {
    const gateway = start();
    await expect(bindAndPrepareRealm(gateway.endpoint, { routePath: "/debug/missing" }))
      .rejects.toThrow("Realm route not found");
  });
});
