import { reconcileRealmDirectory, resolveRealmDirectoryArgs } from "./start-realm-directory";

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
  const invocation = resolveRealmDirectoryArgs(process.argv.slice(2));
  const configPath = await reconcileRealmDirectory(invocation.realmDirectory, await resolveLatestSdkRevision());
  process.argv = invocation.command === "registration-url"
    ? [process.argv[0]!, process.argv[1]!, "registration-url", configPath]
    : [process.argv[0]!, process.argv[1]!, configPath];
  await import("./start-realm-coordinator");
} catch (error) {
  console.error(error instanceof Error ? error.message : "start-realm failed");
  process.exitCode = 1;
}
