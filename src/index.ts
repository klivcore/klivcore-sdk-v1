export * from "./client";
export * from "./contracts";

export type RealmChannelHandlers = Readonly<{
  onOpen?(): void;
  onMessage(data: string | ArrayBuffer): void;
  onClose?(code: number, reason: string): void;
  onError?(error: unknown): void;
}>;

export type RealmChannel = Readonly<{
  readonly readyState: number;
  readonly url: string;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
}>;

export type RealmComponentHost = Readonly<{
  root: ShadowRoot;
  realm: Readonly<{ id: string; name: string; capabilities: readonly string[] }>;
  navigate(path: string): void;
  setBadge(count: number): void;
  openChannel(path: string, handlers: RealmChannelHandlers): RealmChannel;
}>;

export type RealmComponentModule = Readonly<{
  mount(host: RealmComponentHost): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}>;
