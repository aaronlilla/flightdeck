/**
 * Getting a console onto 127.0.0.1:4120: probe, attach if something is
 * already there, otherwise spawn it and wait for it to answer.
 *
 * All I/O is injected (the port probe, the process spawn, the wait clock),
 * so the ordering and the attach/start decision are things a test can drive
 * without a real server or a real child process.
 */
import { decideServerMode, buildStartCommand, type StartCommandFs } from './server-mode';

export interface ProbeResult {
  reachable: boolean;
}

export interface Spawned {
  pid?: number;
  onExit(handler: (code: number | null) => void): void;
  onOutput(handler: (chunk: string) => void): void;
  kill(): void;
}

export interface SupervisorDeps {
  probe(): Promise<ProbeResult>;
  spawn(command: string, args: string[], cwd: string, env: Record<string, string>): Spawned;
  fs: StartCommandFs;
  join(...parts: string[]): string;
  nodeExecPath: string;
  /** Polls `probe()` on an interval until it is reachable or `timeoutMs`
   *  elapses. Injected so a test can drive it without real timers. */
  waitUntilReachable(probe: () => Promise<ProbeResult>, timeoutMs: number): Promise<boolean>;
  onLog(line: string): void;
}

export type SupervisorOutcome =
  | { mode: 'attach' }
  | { mode: 'start'; process: Spawned }
  | { mode: 'start-failed'; reason: string };

/** Ten minutes: long enough for a cold `npm run forge -- up` with no build
 *  cache, short enough that a genuinely stuck launch is reported rather than
 *  waited on forever. */
export const START_TIMEOUT_MS = 10 * 60 * 1000;

export async function bringUpConsole(checkoutDir: string, deps: SupervisorDeps): Promise<SupervisorOutcome> {
  const first = await deps.probe();
  const mode = decideServerMode(first.reachable);
  if (mode === 'attach') {
    deps.onLog('a console is already running on 127.0.0.1:4120; attaching to it');
    return { mode: 'attach' };
  }

  const { command, args, cwd, env } = buildStartCommand(deps.fs, deps.join, checkoutDir, deps.nodeExecPath);
  deps.onLog(`starting the console: ${command} ${args.join(' ')} (in ${cwd})`);
  const child = deps.spawn(command, args, cwd, env);
  child.onOutput((chunk) => deps.onLog(chunk));

  const ready = await deps.waitUntilReachable(() => deps.probe(), START_TIMEOUT_MS);
  if (!ready) {
    child.kill();
    return { mode: 'start-failed', reason: `the console did not answer on 127.0.0.1:4120 within ${START_TIMEOUT_MS / 1000}s` };
  }
  return { mode: 'start', process: child };
}
