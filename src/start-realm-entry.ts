import { planLatestSdkExecution, reconcileRealmDirectory, resolveRealmDirectoryArgs } from "./start-realm-directory";
import { formatStartRealmFailure } from "./start-realm-core";

const SDK_REPOSITORY = "https://github.com/klivcore/klivcore-sdk-v1.git";

export async function resolveLatestSdkRevision(): Promise<string> {
  const child = Bun.spawn(["git", "ls-remote", "--exit-code", SDK_REPOSITORY, "HEAD"], {
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
  const args = process.argv.slice(2);
  const latestRevision = await resolveLatestSdkRevision();
  const execution = planLatestSdkExecution(latestRevision, process.env.KLIVCORE_PINNED_SDK_REVISION);
  if (execution.mode === "delegate") {
    const child = Bun.spawn([
      "bunx",
      "--bun",
      "--package", `${SDK_REPOSITORY}#${execution.revision}`,
      "sdk-v1",
      "start-realm",
      ...args,
    ], {
      env: { ...process.env, KLIVCORE_PINNED_SDK_REVISION: execution.revision },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exitCode = await child.exited;
  } else {
    const invocation = resolveRealmDirectoryArgs(args);
    const configPath = await reconcileRealmDirectory(invocation.realmDirectory, execution.revision);
    process.argv = invocation.command === "registration-url"
      ? [process.argv[0]!, process.argv[1]!, "registration-url", configPath]
      : [process.argv[0]!, process.argv[1]!, ...(invocation.forcePriorDirectory ? ["--force"] : []), configPath];
    await import("./start-realm-coordinator");
  }
} catch (error) {
  console.error(formatStartRealmFailure(error));
  process.exitCode = 1;
}
