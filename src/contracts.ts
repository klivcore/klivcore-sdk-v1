export const PROTOCOL_VERSION = "1.0.0" as const;
export const SCHEMA_VERSION = "1.0.0" as const;
export const HOST_API_VERSION = "1.4.0" as const;

export type ArtifactReference = Readonly<{ url: string; sha256: string; mediaType: "text/javascript" | "text/css" }>;
export type ComponentPublication = Readonly<{
  id: string;
  hostApiRange: string;
  js: ArtifactReference;
  css: ArtifactReference;
}>;
export type RealmRoute = Readonly<{
  id: string;
  path: string;
  title: string;
  requiredCapabilities: readonly string[];
  services: readonly Readonly<{ id: string; endpoint: string }>[];
  component: ComponentPublication;
}>;
export type RealmCatalog = Readonly<{
  schemaVersion: typeof SCHEMA_VERSION;
  realmId: string;
  generation: string;
  defaultRouteId: string;
  routes: readonly RealmRoute[];
}>;
export type RealmDescriptor = Readonly<{
  protocolVersion: typeof PROTOCOL_VERSION;
  realmId: string;
  name: string;
  authority: Readonly<{ bindingId: string; epoch: string }>;
  publication: Readonly<{
    catalogUrl: string;
    catalogSha256: string;
    generation: string;
    hostApiRange: string;
  }>;
  capabilities: readonly string[];
}>;

const own = Object.prototype.hasOwnProperty;
const idPattern = /^[a-z][a-z0-9]*(?:[-:][a-z0-9]+)*$/;
const hashPattern = /^[a-f0-9]{64}$/;
const capabilityPattern = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

function plain(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new Error(`${label} has unknown field ${String(key)}`);
  }
  for (const key of allowed) if (!own.call(value, key)) throw new Error(`${label} is missing ${key}`);
}
function text(value: unknown, label: string, max = 160): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} must be bounded text`);
  }
  return value;
}
function id(value: unknown, label: string): string {
  const parsed = text(value, label, 96);
  if (!idPattern.test(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}
function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !hashPattern.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
  return value;
}
function absoluteHttpUrl(value: unknown, label: string): string {
  const parsed = text(value, label, 2048);
  let url: URL;
  try { url = new URL(parsed); } catch { throw new Error(`${label} must be an absolute URL`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} must use HTTP(S)`);
  if (url.username || url.password || url.hash) throw new Error(`${label} contains forbidden URL parts`);
  return url.toString();
}
function denseArray(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) throw new Error(`${label} must be a bounded array`);
  for (let index = 0; index < value.length; index += 1) if (!own.call(value, index)) throw new Error(`${label} must be dense`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      throw new Error(`${label} has unknown array properties`);
    }
  }
  return value;
}
function capabilityList(value: unknown, label: string): readonly string[] {
  const result = denseArray(value, label, 64).map((entry) => {
    const parsed = text(entry, `${label} entry`, 96);
    if (!capabilityPattern.test(parsed)) throw new Error(`${label} entry is invalid`);
    return parsed;
  });
  if (new Set(result).size !== result.length) throw new Error(`${label} has duplicates`);
  return Object.freeze(result);
}
function semver(value: string): [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error("invalid semantic version");
  const parsed: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!parsed.every(Number.isSafeInteger)) throw new Error("invalid semantic version");
  return parsed;
}
export function supportsHostApi(range: string, version = HOST_API_VERSION): boolean {
  const current = semver(version);
  if (range.startsWith("^")) {
    const required = semver(range.slice(1));
    const atLeastRequired = current[0] > required[0]
      || (current[0] === required[0] && (current[1] > required[1]
        || (current[1] === required[1] && current[2] >= required[2])));
    if (!atLeastRequired) return false;
    if (required[0] > 0) return current[0] === required[0];
    if (required[1] > 0) return current[0] === 0 && current[1] === required[1];
    return current[0] === 0 && current[1] === 0 && current[2] === required[2];
  }
  return range === version;
}

function parseArtifact(value: unknown, mediaType: ArtifactReference["mediaType"], label: string): ArtifactReference {
  const object = plain(value, label);
  exact(object, ["url", "sha256", "mediaType"], label);
  if (object.mediaType !== mediaType) throw new Error(`${label} has invalid media type`);
  return Object.freeze({ url: absoluteHttpUrl(object.url, `${label}.url`), sha256: sha(object.sha256, `${label}.sha256`), mediaType });
}

export function parseRealmDescriptor(value: unknown, hostApiVersion = HOST_API_VERSION): RealmDescriptor {
  const object = plain(value, "descriptor");
  exact(object, ["protocolVersion", "realmId", "name", "authority", "publication", "capabilities"], "descriptor");
  if (object.protocolVersion !== PROTOCOL_VERSION) throw new Error("incompatible Realm protocol version");
  const authority = plain(object.authority, "descriptor.authority");
  exact(authority, ["bindingId", "epoch"], "descriptor.authority");
  const publication = plain(object.publication, "descriptor.publication");
  exact(publication, ["catalogUrl", "catalogSha256", "generation", "hostApiRange"], "descriptor.publication");
  const hostApiRange = text(publication.hostApiRange, "descriptor.publication.hostApiRange", 32);
  if (!supportsHostApi(hostApiRange, hostApiVersion)) throw new Error("incompatible host API range");
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    realmId: id(object.realmId, "descriptor.realmId"),
    name: text(object.name, "descriptor.name"),
    authority: Object.freeze({ bindingId: text(authority.bindingId, "descriptor.authority.bindingId", 128), epoch: id(authority.epoch, "descriptor.authority.epoch") }),
    publication: Object.freeze({
      catalogUrl: absoluteHttpUrl(publication.catalogUrl, "descriptor.publication.catalogUrl"),
      catalogSha256: sha(publication.catalogSha256, "descriptor.publication.catalogSha256"),
      generation: id(publication.generation, "descriptor.publication.generation"),
      hostApiRange,
    }),
    capabilities: capabilityList(object.capabilities, "descriptor.capabilities"),
  });
}

export function parseRealmCatalog(value: unknown): RealmCatalog {
  const object = plain(value, "catalog");
  exact(object, ["schemaVersion", "realmId", "generation", "defaultRouteId", "routes"], "catalog");
  if (object.schemaVersion !== SCHEMA_VERSION) throw new Error("incompatible catalog schema version");
  const routes = denseArray(object.routes, "catalog.routes", 128).map((entry, index): RealmRoute => {
    const route = plain(entry, `catalog.routes[${index}]`);
    const hasServices = own.call(route, "services");
    exact(route, ["id", "path", "title", "requiredCapabilities", ...(hasServices ? ["services"] : []), "component"], `catalog.routes[${index}]`);
    const path = text(route.path, `catalog.routes[${index}].path`, 512);
    if (!/^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test(path)) throw new Error("route path is invalid");
    const component = plain(route.component, `catalog.routes[${index}].component`);
    exact(component, ["id", "hostApiRange", "js", "css"], `catalog.routes[${index}].component`);
    const hostApiRange = text(component.hostApiRange, "component.hostApiRange", 32);
    if (!supportsHostApi(hostApiRange)) throw new Error("component has incompatible host API range");
    const services = hasServices ? denseArray(route.services, `catalog.routes[${index}].services`, 8).map((entry, serviceIndex) => {
      const service = plain(entry, `catalog.routes[${index}].services[${serviceIndex}]`);
      exact(service, ["id", "endpoint"], `catalog.routes[${index}].services[${serviceIndex}]`);
      const endpoint = text(service.endpoint, `catalog.routes[${index}].services[${serviceIndex}].endpoint`, 32);
      if (!/^\/:([1-9]\d{0,4})$/.test(endpoint) || Number(endpoint.slice(2)) > 65_535) throw new Error("route service endpoint is invalid");
      return Object.freeze({ id: id(service.id, `catalog.routes[${index}].services[${serviceIndex}].id`), endpoint });
    }) : [];
    if (new Set(services.map((service) => service.id)).size !== services.length) throw new Error("duplicate route service id");
    return Object.freeze({
      id: id(route.id, "route.id"), path, title: text(route.title, "route.title"),
      requiredCapabilities: capabilityList(route.requiredCapabilities, "route.requiredCapabilities"),
      services: Object.freeze(services),
      component: Object.freeze({ id: id(component.id, "component.id"), hostApiRange,
        js: parseArtifact(component.js, "text/javascript", "component.js"),
        css: parseArtifact(component.css, "text/css", "component.css") }),
    });
  });
  const routeIds = new Set<string>();
  const paths = new Set<string>();
  for (const route of routes) {
    if (routeIds.has(route.id)) throw new Error("duplicate route id");
    if (paths.has(route.path)) throw new Error("duplicate route path");
    routeIds.add(route.id); paths.add(route.path);
  }
  const defaultRouteId = id(object.defaultRouteId, "catalog.defaultRouteId");
  if (!routeIds.has(defaultRouteId)) throw new Error("default route is missing");
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, realmId: id(object.realmId, "catalog.realmId"), generation: id(object.generation, "catalog.generation"), defaultRouteId, routes: Object.freeze(routes) });
}
