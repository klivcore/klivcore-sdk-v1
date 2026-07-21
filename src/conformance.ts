import { bindAndPrepareRealm, type RealmClientOptions } from "./client";

export type ConformanceReport = Readonly<{
  ok: true;
  realmId: string;
  name: string;
  defaultRoute: string;
  componentId: string;
  capabilities: readonly string[];
  verifiedArtifacts: readonly ["text/javascript", "text/css"];
}>;

export async function verifyRealmEndpoint(endpoint: string, options: RealmClientOptions = {}): Promise<ConformanceReport> {
  const prepared = await bindAndPrepareRealm(endpoint, options);
  return Object.freeze({
    ok: true as const,
    realmId: prepared.descriptor.realmId,
    name: prepared.descriptor.name,
    defaultRoute: prepared.route.path,
    componentId: prepared.route.component.id,
    capabilities: Object.freeze([...prepared.descriptor.capabilities]),
    verifiedArtifacts: Object.freeze(["text/javascript", "text/css"] as const),
  });
}
