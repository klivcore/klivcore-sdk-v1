import { afterEach, describe, expect, test } from "bun:test";
import { bindAndPrepareRealm } from "./client";
import { createRealmGateway, type RealmGatewayService, type RunningRealmGateway } from "./server";

const running: RunningRealmGateway[] = [];
afterEach(() => {
  for (const gateway of running.splice(0)) gateway.stop();
});

function start(
  services: readonly RealmGatewayService[] = [],
  publicBindingCapabilities?: readonly string[],
  maxPublicBindings?: number,
) {
  const gateway = createRealmGateway({
    branding: { canvasColor: "#07090d" },
    hostname: "127.0.0.1",
    port: 0,
    realmId: "test-realm",
    name: "Test Realm",
    authorityEpoch: "test-1",
    generation: "test-1",
    capabilities: ["realm:view", "test:inspect"],
    publicBindingCapabilities,
    maxPublicBindings,
    services,
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
    expect(candidate.route.component.hostApiRange).toBe("^1.2.0");
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

  test("shares an authenticated Realm badge across independent bindings", async () => {
    const gateway = start();
    const publisher = await bindAndPrepareRealm(gateway.endpoint);
    const observer = await bindAndPrepareRealm(gateway.endpoint);
    const publish = await fetch(`${gateway.endpoint}/v1/badge/3`, {
      method: "POST",
      headers: { authorization: `Bearer ${publisher.descriptor.authority.bindingId}` },
    });
    const observed = await fetch(`${gateway.endpoint}/v1/badge`, {
      headers: { authorization: `Bearer ${observer.descriptor.authority.bindingId}` },
    });

    expect(publish.status).toBe(200);
    expect(await publish.json()).toEqual({ revision: 1, count: 3 });
    expect(await observed.json()).toEqual({ revision: 1, count: 3 });
  });

  test("rejects unauthorized and invalid Realm badge updates", async () => {
    const gateway = start();
    const candidate = await bindAndPrepareRealm(gateway.endpoint);
    const unauthorized = await fetch(`${gateway.endpoint}/v1/badge/2`, { method: "POST" });
    const invalid = await fetch(`${gateway.endpoint}/v1/badge/1000`, {
      method: "POST",
      headers: { authorization: `Bearer ${candidate.descriptor.authority.bindingId}` },
    });

    expect(unauthorized.status).toBe(401);
    expect(invalid.status).toBe(400);
  });

  test("streams bounded Realm-attributed badge changes after binding authentication", async () => {
    const gateway = start();
    const candidate = await bindAndPrepareRealm(gateway.endpoint);
    const socket = new WebSocket(`${gateway.endpoint.replace("http://", "ws://")}/v1/notifications`);
    const opened = new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("notification socket failed")), { once: true });
    });
    const nextMessage = () => new Promise<unknown>((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true });
      socket.addEventListener("error", () => reject(new Error("notification socket failed")), { once: true });
    });

    await opened;
    const initial = nextMessage();
    socket.send(JSON.stringify({ type: "authenticate", bindingId: candidate.descriptor.authority.bindingId }));
    expect(await initial).toEqual({ type: "badge.changed", realmId: "test-realm", revision: 0, count: 0 });

    const changed = nextMessage();
    await fetch(`${gateway.endpoint}/v1/badge/4`, {
      method: "POST",
      headers: { authorization: "Bea" + "rer " + candidate.descriptor.authority.bindingId },
    });
    expect(await changed).toEqual({ type: "badge.changed", realmId: "test-realm", revision: 1, count: 4 });
    socket.close();
  });

  test("hosts an authority-neutral authenticated Realm service", async () => {
    let closed = 0;
    let resolveClosed!: () => void;
    const didClose = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const service: RealmGatewayService = {
      path: "/v1/test-service",
      requiredCapabilities: ["test:inspect"],
      maxMessageBytes: 128,
      handleRequest(_request, url) {
        return new Response(JSON.stringify({ path: url.pathname }));
      },
      connect(channel) {
        channel.send(JSON.stringify({ type: "test.ready" }));
        return {
          message(data) {
            channel.send(typeof data === "string" ? data.toUpperCase() : data);
          },
          close() { closed += 1; resolveClosed(); },
        };
      },
    };
    const gateway = start([service]);
    const candidate = await bindAndPrepareRealm(gateway.endpoint);
    const unauthorized = await fetch(`${gateway.endpoint}/v1/test-service`);
    expect(unauthorized.status).toBe(401);
    const authorized = await fetch(`${gateway.endpoint}/v1/test-service`, {
      headers: { authorization: `Bearer ${candidate.descriptor.authority.bindingId}` },
    });
    expect(await authorized.json()).toEqual({ path: "/v1/test-service" });

    const socket = new WebSocket(`${gateway.endpoint.replace("http://", "ws://")}/v1/test-service`);
    const nextMessage = () => new Promise<string>((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
      socket.addEventListener("error", () => reject(new Error("service socket failed")), { once: true });
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("service socket failed")), { once: true });
    });
    const authenticated = nextMessage();
    socket.send(JSON.stringify({ type: "authenticate", bindingId: candidate.descriptor.authority.bindingId }));
    expect(JSON.parse(await authenticated)).toEqual({ type: "test.ready" });

    const echoed = nextMessage();
    socket.send("hello service");
    expect(await echoed).toBe("HELLO SERVICE");
    socket.close();
    await didClose;
    expect(closed).toBe(1);
  });

  test("denies a service to public bindings and accepts a trusted scoped binding", async () => {
    let connections = 0;
    const gateway = start([{
      path: "/v1/scoped-service",
      requiredCapabilities: ["test:inspect"],
      maxMessageBytes: 64,
      handleRequest() { return new Response("authorized"); },
      connect() { connections += 1; return { message() {} }; },
    }], ["realm:view"]);
    const candidate = await bindAndPrepareRealm(gateway.endpoint);
    const denied = await fetch(`${gateway.endpoint}/v1/scoped-service`, {
      headers: { authorization: "Bea" + "rer " + candidate.descriptor.authority.bindingId },
    });
    expect(denied.status).toBe(403);

    const socket = new WebSocket(`${gateway.endpoint.replace("http://", "ws://")}/v1/scoped-service`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("scoped service socket failed")), { once: true });
    });
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
    socket.send(JSON.stringify({ type: "authenticate", bindingId: candidate.descriptor.authority.bindingId }));
    expect((await closed).code).toBe(1008);
    expect(connections).toBe(0);

    const trusted = gateway.issueBinding(["test:inspect"]);
    const authorized = await fetch(`${gateway.endpoint}/v1/scoped-service`, {
      headers: { authorization: "Bea" + "rer " + trusted.bindingId },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.text()).toBe("authorized");
  });

  test("keeps public binding churn isolated from trusted producer grants", async () => {
    const gateway = start([{
      path: "/v1/trusted-service",
      requiredCapabilities: ["test:inspect"],
      maxMessageBytes: 64,
      handleRequest() { return new Response("trusted"); },
      connect() { return { message() {} }; },
    }], ["realm:view"], 1);
    const trusted = gateway.issueBinding(["test:inspect"]);
    expect((await fetch(`${gateway.endpoint}/v1/bind`, { method: "POST" })).status).toBe(200);
    expect((await fetch(`${gateway.endpoint}/v1/bind`, { method: "POST" })).status).toBe(200);

    const authorized = await fetch(`${gateway.endpoint}/v1/trusted-service`, {
      headers: { authorization: "Bea" + "rer " + trusted.bindingId },
    });
    expect(authorized.status).toBe(200);
    gateway.revokeBinding(trusted.bindingId);
    expect((await fetch(`${gateway.endpoint}/v1/trusted-service`, {
      headers: { authorization: "Bea" + "rer " + trusted.bindingId },
    })).status).toBe(401);
  });

  test("closes an authenticated service session when its trusted binding is revoked", async () => {
    let closedSessions = 0;
    const gateway = start([{
      path: "/v1/revocable-service",
      requiredCapabilities: ["test:inspect"],
      maxMessageBytes: 64,
      connect(channel) {
        channel.send("ready");
        return { message() {}, close() { closedSessions += 1; } };
      },
    }], ["realm:view"]);
    const trusted = gateway.issueBinding(["test:inspect"]);
    const socket = new WebSocket(`${gateway.endpoint.replace("http://", "ws://")}/v1/revocable-service`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("revocable service socket failed")), { once: true });
    });
    const ready = new Promise<string>((resolve) => socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }));
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
    socket.send(JSON.stringify({ type: "authenticate", bindingId: trusted.bindingId }));
    expect(await ready).toBe("ready");

    expect(gateway.revokeBinding(trusted.bindingId)).toBe(true);
    expect((await closed).code).toBe(1008);
    expect(closedSessions).toBe(1);
  });

  test("closes an authenticated public session when its binding is evicted", async () => {
    let closedSessions = 0;
    const gateway = start([{
      path: "/v1/public-service",
      requiredCapabilities: ["realm:view"],
      maxMessageBytes: 64,
      connect(channel) {
        channel.send("ready");
        return { message() {}, close() { closedSessions += 1; } };
      },
    }], ["realm:view"], 1);
    const candidate = await bindAndPrepareRealm(gateway.endpoint);
    const socket = new WebSocket(`${gateway.endpoint.replace("http://", "ws://")}/v1/public-service`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("public service socket failed")), { once: true });
    });
    const ready = new Promise<string>((resolve) => socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }));
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
    socket.send(JSON.stringify({ type: "authenticate", bindingId: candidate.descriptor.authority.bindingId }));
    expect(await ready).toBe("ready");

    expect((await fetch(`${gateway.endpoint}/v1/bind`, { method: "POST" })).status).toBe(200);
    expect((await closed).code).toBe(1008);
    expect(closedSessions).toBe(1);
  });

  test("applies a service's UTF-8 byte limit only after binding authentication", async () => {
    let received = 0;
    const gateway = start([{
      path: "/v1/byte-bounded",
      requiredCapabilities: ["realm:view"],
      maxMessageBytes: 5,
      connect(channel) {
        channel.send(JSON.stringify({ type: "bounded.ready" }));
        return { message() { received += 1; } };
      },
    }]);
    const candidate = await bindAndPrepareRealm(gateway.endpoint);
    const socket = new WebSocket(`${gateway.endpoint.replace("http://", "ws://")}/v1/byte-bounded`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("bounded service socket failed")), { once: true });
    });
    const ready = new Promise<string>((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
      socket.addEventListener("close", () => reject(new Error("service closed before authentication completed")), { once: true });
    });
    socket.send(JSON.stringify({ type: "authenticate", bindingId: candidate.descriptor.authority.bindingId }));
    expect(JSON.parse(await ready)).toEqual({ type: "bounded.ready" });

    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
    socket.send("ééé");
    expect((await closed).code).toBe(1008);
    expect(received).toBe(0);
  });
});
