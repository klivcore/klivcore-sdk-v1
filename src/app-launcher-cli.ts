export type AppV2LauncherCliOptions = Readonly<{ hostname: "127.0.0.1" | "localhost" | "0.0.0.0"; port: number }>;

export function parseAppV2LauncherArgs(args: readonly string[]): AppV2LauncherCliOptions {
  let hostname: AppV2LauncherCliOptions["hostname"] = "127.0.0.1";
  let port = 45174;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument !== "--host" && argument !== "--port") throw new TypeError(`unknown argument: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${argument} requires a value`);
    index += 1;
    if (argument === "--host") {
      if (value !== "127.0.0.1" && value !== "localhost" && value !== "0.0.0.0") {
        throw new TypeError("host must be 127.0.0.1, localhost, or 0.0.0.0");
      }
      hostname = value;
    } else {
      if (!/^[1-9]\d*$/.test(value)) throw new TypeError("port must be between 1 and 65535");
      port = Number(value);
      if (!Number.isSafeInteger(port) || port > 65_535) throw new TypeError("port must be between 1 and 65535");
    }
  }
  return Object.freeze({ hostname, port });
}
