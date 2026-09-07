/**
 * Whether the queue subsystem is running at all, distinct from a queue that is running
 * but merely paused. Same rule the server itself uses (`server.ts`'s `state()`:
 * `queue_on: process.env['FORGE_QUEUE'] === '1'`) -- kept here as its own pure function so
 * the status window can show "Queue is off" against the exact environment the console is
 * about to be spawned with (base env plus this app's own `forgeEnv` settings), before that
 * console has even started answering `/state` for itself.
 */
export function queueIsOn(env: Record<string, string | undefined>): boolean {
  return env['FORGE_QUEUE'] === '1';
}
