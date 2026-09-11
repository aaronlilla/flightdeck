/**
 * Item 4, plan step 5, 2026-09-10: the console.launch.cmd loop's own pre-check,
 * pulled out of the batch script into testable logic. Before the loop rebuilds
 * the console and runs `forge up` again, it asks whether the console already
 * answers `/health` -- if so, rebuilding would run `vite.console.config.ts`'s
 * `emptyOutDir: true` build under a live server, transiently wiping the page
 * that server is serving (the exact hazard plan step 5 names). Skipping is the
 * only safe default.
 */
export interface HealthCheck {
  ok: boolean;
}

export type LauncherPreCheckResult =
  | { action: 'skip'; reason: string }
  | { action: 'build-and-start' };

/** `checkHealth` is the caller's own `/health` probe result -- kept out of this
 *  function so the decision has no I/O in it, same discipline as every other
 *  decision function in this goal. */
export function launcherPreCheck(health: HealthCheck): LauncherPreCheckResult {
  if (health.ok) {
    return { action: 'skip', reason: 'console already healthy, not rebuilding' };
  }
  return { action: 'build-and-start' };
}
