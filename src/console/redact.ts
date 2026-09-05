/**
 * Redact applied before every sink the console touches.
 *
 * The spec names an existing defect elsewhere in the fleet, where a verbatim
 * error or exec dump reaches a gotcha file, a report row, or a log
 * unredacted (`gotcha.ts`, `exec.ts`, `sdkengine.ts` on main). The console's
 * own display layer must not repeat it: a 4xx from `/answer` or any other
 * write shows only the server's own `{ error }` message, never a raw body,
 * and anything that looks like a filesystem path is stripped from what does
 * get shown.
 *
 * This is cut 1's own copy. The spec plans a shared `Redact` used by Warden,
 * Intake and Console alike; until that module exists, this is the console's
 * standing implementation, reconciled the same way the fixtures are once the
 * shared one lands.
 */

const WINDOWS_PATH = /[a-z]:[\\/][^\s"'`]*/gi;
const POSIX_HOME_PATH = /\/(?:home|Users)\/[^\s"'`]*/gi;

export function redactText(text: string): string {
  return text.replace(WINDOWS_PATH, '[path]').replace(POSIX_HOME_PATH, '[path]');
}

/**
 * A failed write's body, reduced to something safe to show.
 *
 * The server always answers a failure as JSON `{ error }` (see
 * `server.ts#json`), so the message a person already wrote is what surfaces.
 * Anything that fails to parse as that shape becomes a flat, honest
 * fallback rather than the raw body.
 */
export function redactErrorBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string') return redactText(parsed.error);
  } catch {
    // Not JSON. Fall through to the generic message below.
  }
  return 'the server did not say why';
}
