import { spawn as nodeSpawn, spawnSync as nodeSpawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface CliCommandSpec {
  command: string;
  args: string[];
  input?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface CliCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

type SpawnSyncLike = typeof nodeSpawnSync;

export function killSpawnedProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  deps: {
    platform?: NodeJS.Platform;
    killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): void {
  if (!child.pid) return;
  const platform = deps.platform ?? process.platform;
  const killProcess = deps.killProcess ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  if (platform !== "win32") {
    killProcess(-child.pid, signal);
    return;
  }
  child.kill(signal);
}

export function probeCommandAvailability(
  command: string,
  deps: { spawnSyncImpl?: SpawnSyncLike } = {},
): boolean {
  return (deps.spawnSyncImpl ?? nodeSpawnSync)("which", [command], { stdio: "pipe" }).status === 0;
}

export async function runCliCommand(
  spec: CliCommandSpec,
  deps: {
    spawnImpl?: SpawnLike;
    platform?: NodeJS.Platform;
    killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): Promise<CliCommandResult> {
  const spawnImpl = deps.spawnImpl ?? nodeSpawn;

  return await new Promise<CliCommandResult>((resolve) => {
    const child = spawnImpl(
      spec.command,
      spec.args,
      {
        stdio: ["pipe", "pipe", "pipe"],
        detached: (deps.platform ?? process.platform) !== "win32",
        env: spec.env,
      },
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result: CliCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killSpawnedProcessGroup(child, "SIGTERM", {
        platform: deps.platform,
        killProcess: deps.killProcess,
      });
    }, spec.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      finish({
        stdout,
        stderr: stderr || error.message,
        exitCode: null,
        signal: null,
        timedOut,
      });
    });
    child.on("close", (exitCode, signal) => {
      finish({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
      });
    });

    if (spec.input !== undefined) {
      child.stdin?.end(spec.input);
    } else {
      child.stdin?.end();
    }
  });
}
