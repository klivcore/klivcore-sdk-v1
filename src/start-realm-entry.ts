import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  planLatestSdkExecution,
  reconcileRealmDirectory,
  resolveRealmDirectoryArgs,
  resolveSdkChannelArgs,
  sdkRemoteRef,
  type SdkChannel,
} from "./start-realm-directory";
import { formatStartRealmFailure } from "./start-realm-core";
import { installRealmKcRegistration, preflightRealmKcRegistration } from "./realm-kc-registration";

const SDK_REPOSITORY = "https://github.com/klivcore/klivcore-sdk-v1.git";
const INTERNAL_SDK_REVISION_ARGUMENT = "--klivcore-internal-sdk-revision";
const FULL_REVISION = /^[a-f0-9]{40}$/u;

function resolveInternalSdkInvocation(
  args: readonly string[],
  pinnedRevision: string | undefined,
): Readonly<{ args: readonly string[]; revision?: string }> {
  const hasInternalMetadata = args.some((argument) => argument === INTERNAL_SDK_REVISION_ARGUMENT
    || argument.startsWith(`${INTERNAL_SDK_REVISION_ARGUMENT}=`));
  if (args[0] !== INTERNAL_SDK_REVISION_ARGUMENT) {
    if (hasInternalMetadata) throw new TypeError("Internal SDK invocation marker must be the first argument");
    return Object.freeze({ args: Object.freeze([...args]) });
  }
  const revision = args[1];
  if (!revision || !FULL_REVISION.test(revision)) {
    throw new TypeError("Internal SDK invocation revision must be a full lowercase Git commit");
  }
  if (args.slice(2).some((argument) => argument === INTERNAL_SDK_REVISION_ARGUMENT
    || argument.startsWith(`${INTERNAL_SDK_REVISION_ARGUMENT}=`))) {
    throw new TypeError("Internal SDK invocation marker may be specified once");
  }
  if (pinnedRevision !== revision) {
    throw new TypeError("Internal SDK invocation revision does not match pinned SDK revision");
  }
  return Object.freeze({ args: Object.freeze(args.slice(2)), revision });
}

export async function resolveLatestSdkRevision(channel: SdkChannel = "production"): Promise<string> {
  const child = Bun.spawn(["git", "ls-remote", "--exit-code", SDK_REPOSITORY, sdkRemoteRef(channel)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const revision = stdout.trim().split(/\s+/u)[0];
  if (exitCode !== 0 || !revision || !/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error(stderr.trim() || "Could not resolve the latest Klivcore SDK revision");
  }
  return revision;
}

try {
  const internalInvocation = resolveInternalSdkInvocation(
    process.argv.slice(2),
    process.env.KLIVCORE_PINNED_SDK_REVISION,
  );
  const args = internalInvocation.args;
  const sdkInvocation = resolveSdkChannelArgs(args);
  const execution = internalInvocation.revision === undefined
    ? planLatestSdkExecution(await resolveLatestSdkRevision(sdkInvocation.channel))
    : planLatestSdkExecution(internalInvocation.revision, internalInvocation.revision);
  if (execution.mode === "delegate") {
    const child = Bun.spawn([
      "bunx",
      "--bun",
      "--package", `${SDK_REPOSITORY}#${execution.revision}`,
      "sdk-v1",
      "start-realm",
      INTERNAL_SDK_REVISION_ARGUMENT,
      execution.revision,
      ...args,
    ], {
      env: { ...process.env, KLIVCORE_PINNED_SDK_REVISION: execution.revision },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exitCode = await child.exited;
  } else {
    const invocation = resolveRealmDirectoryArgs(sdkInvocation.realmArgs);
    const configPath = await reconcileRealmDirectory(invocation.realmDirectory, execution.revision);
    const kcRegistration = {
      home: homedir(),
      realmRoot: invocation.realmDirectory,
      sdkRevision: execution.revision,
      sourceEntrypoint: resolve(import.meta.dir, "../bin/kc.ts"),
    };
    if (invocation.command === "run") await preflightRealmKcRegistration(kcRegistration);
    process.argv = invocation.command === "registration-url"
      ? [process.argv[0]!, process.argv[1]!, "registration-url", configPath]
      : [process.argv[0]!, process.argv[1]!, ...(invocation.forcePriorDirectory ? ["--force"] : []), configPath];
    await import("./start-realm-coordinator");
    if (invocation.command === "run") {
      await installRealmKcRegistration(kcRegistration);
      console.log(`Realm commands: kc plugins (registered ${invocation.realmDirectory})`);
    }
  }
} catch (error) {
  console.error(formatStartRealmFailure(error));
  process.exitCode = 1;
}
