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
});
