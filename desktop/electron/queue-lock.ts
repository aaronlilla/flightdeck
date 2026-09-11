/**
 * Reads `<forgeHome>/console/queue.lock` before any launch decision (item 3,
 * plan step 3, 2026-09-10): the same lock `queueLock.ts` uses server-side to
 * keep one process ticking the intake queue at a time. Read-only from this
 * app's side -- it never writes or steals the lock, only asks whether its
 * owner is alive, so `decideConsoleAction` can yield `wait` instead of ever
 * launching a second console into a port whose owner is mid-launch and has
 * not answered a probe yet.
 *
 * `forgeHomeDir` is `FORGE_HOME` itself when set, else `<home>/.forge` --
 * `src/forge/paths.ts`'s own `forgeHome()` convention, matched deliberately
 * (code-review finding, 2026-09-10): the queue lock the server actually
 * writes lives wherever `FORGE_HOME` points, and a caller that always assumes
 * the OS home directory silently checks the wrong lock file whenever
 * `FORGE_HOME` is overridden (every test in this repo, and any alternate
 * install), defeating this exact check without ever raising an error.
 */
export interface QueueLockFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
}

export interface QueueLockOwner {
  pid: number;
  alive: boolean;
}

export function readQueueLockOwner(
  fs: QueueLockFs,
  join: (...parts: string[]) => string,
  forgeHomeDir: string,
  isAlive: (pid: number) => boolean,
): QueueLockOwner | undefined {
  const path = join(forgeHomeDir, 'console', 'queue.lock');
  if (!fs.existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8')) as { pid?: unknown };
    if (typeof parsed.pid !== 'number') return undefined;
    return { pid: parsed.pid, alive: isAlive(parsed.pid) };
  } catch {
    return undefined;
  }
}
