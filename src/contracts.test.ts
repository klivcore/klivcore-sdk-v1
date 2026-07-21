import { describe, expect, test } from "bun:test";
import { HOST_API_VERSION, parseRealmCatalog, parseRealmDescriptor, supportsHostApi } from "./contracts";

const hash = "a".repeat(64);
const descriptor = {
  protocolVersion: "1.0.0",
  realmId: "development",
  name: "Development Realm",
  authority: { bindingId: "binding-123", epoch: "dev-1" },
  publication: {
    catalogUrl: "http://127.0.0.1:47001/v1/catalog",
    catalogSha256: hash,
    generation: "development-1",
    hostApiRange: "^1.0.0",
  },
  capabilities: ["realm:view", "development:inspect"],
};

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
      js: { url: "http://127.0.0.1:47001/artifacts/home.js", sha256: hash, mediaType: "text/javascript" },
      css: { url: "http://127.0.0.1:47001/artifacts/home.css", sha256: hash, mediaType: "text/css" },
    },
  }],
};

describe("strict Realm publication contracts", () => {
  test("reconstructs and deeply freezes a compatible descriptor", () => {
    const parsed = parseRealmDescriptor(descriptor, HOST_API_VERSION);
    expect(parsed).not.toBe(descriptor);
    expect(parsed.realmId).toBe("development");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.publication)).toBe(true);
    expect(Object.isFrozen(parsed.capabilities)).toBe(true);
  });

  test("rejects unknown descriptor fields", () => {
    expect(() => parseRealmDescriptor({ ...descriptor, productRoutes: [] }, HOST_API_VERSION)).toThrow("unknown field");
  });

  test("rejects non-index properties on contract arrays", () => {
    const capabilities = ["realm:view"];
    Object.defineProperty(capabilities, "unexpected", { value: true, enumerable: true });
    expect(() => parseRealmDescriptor({ ...descriptor, capabilities }, HOST_API_VERSION)).toThrow("array properties");
  });

  test("rejects an incompatible host API range", () => {
    expect(() => parseRealmDescriptor({
      ...descriptor,
      publication: { ...descriptor.publication, hostApiRange: "^2.0.0" },
    }, HOST_API_VERSION)).toThrow("host API");
  });

  test("implements caret compatibility for pre-1.0 host APIs", () => {
    expect(supportsHostApi("^0.1.0", "0.1.9")).toBe(true);
    expect(supportsHostApi("^0.1.0", "0.2.0")).toBe(false);
    expect(supportsHostApi("^0.0.1", "0.0.1")).toBe(true);
    expect(supportsHostApi("^0.0.1", "0.0.2")).toBe(false);
  });

  test("reconstructs a catalog and rejects ambiguous duplicate paths", () => {
    const parsed = parseRealmCatalog(catalog);
    expect(Object.isFrozen(parsed.routes[0]!.component.js)).toBe(true);
    expect(() => parseRealmCatalog({
      ...catalog,
      routes: [...catalog.routes, { ...catalog.routes[0], id: "other" }],
    })).toThrow("duplicate route path");
  });
});
