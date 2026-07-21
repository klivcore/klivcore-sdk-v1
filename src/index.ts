export * from "./client";
export * from "./contracts";

export type RealmComponentHost = Readonly<{
  root: ShadowRoot;
  realm: Readonly<{ id: string; name: string; capabilities: readonly string[] }>;
  navigate(path: string): void;
}>;

export type RealmComponentModule = Readonly<{
  mount(host: RealmComponentHost): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}>;
