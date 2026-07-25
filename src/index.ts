export * from "./client";
export * from "./contracts";

import type { PreparedRealmService, RealmChannel, RealmChannelHandlers } from "./client";

export type RealmComponentHost = Readonly<{
  root: ShadowRoot;
  realm: Readonly<{ id: string; name: string; capabilities: readonly string[] }>;
  services: Readonly<Record<string, PreparedRealmService>>;
  navigate(path: string): void;
  setBadge(count: number): void;
  openChannel(path: string, handlers: RealmChannelHandlers): RealmChannel;
}>;

export type RealmComponentModule = Readonly<{
  mount(host: RealmComponentHost): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}>;
