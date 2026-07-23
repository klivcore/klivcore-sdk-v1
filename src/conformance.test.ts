import { afterEach, describe, expect, test } from "bun:test";
import { verifyRealmEndpoint } from "./conformance";
import { createRealmGateway, type RunningRealmGateway } from "./server";

let gateway: RunningRealmGateway | undefined;
afterEach(() => gateway?.stop());

describe("SDK conformance suite", () => {
  test("reports the verified Realm identity, route, artifacts, and capabilities", async () => {
    gateway = createRealmGateway({
      branding: { canvasColor: "#07090d" },
      hostname: "127.0.0.1",
      port: 0,
      realmId: "conformance-realm",
      name: "Conformance Realm",
      authorityEpoch: "conformance-1",
      generation: "conformance-1",
      capabilities: ["realm:view", "conformance:inspect"],
      defaultRoute: {
        id: "home", path: "/", title: "Home", requiredCapabilities: ["realm:view"],
        componentId: "conformance-home",
        js: "export function mount(){return undefined}",
        css: ":host{display:block}",
      },
    });
    const report = await verifyRealmEndpoint(gateway.endpoint);
    expect(report).toEqual({
      ok: true,
      realmId: "conformance-realm",
      name: "Conformance Realm",
      defaultRoute: "/",
      componentId: "conformance-home",
      capabilities: ["realm:view", "conformance:inspect"],
      verifiedArtifacts: ["text/javascript", "text/css"],
    });
  });
});
