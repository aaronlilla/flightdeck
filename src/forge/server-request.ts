/**
 * The one place a CLI verb talks to the `forge up` server on 4120. Reads the bearer
 * token fresh off disk (`serverTokenPath()`) on every call -- the same file `ensureServerToken`
 * mints -- and sends it as `X-Forge-Token`, never `Authorization: Bearer`, which is the
 * header the server actually checks (`server.ts#authorized`).
 *
 * Before this, a CLI verb that needed the running server had to be typed out by hand:
 * read the token file, curl, guess the header. That guess was wrong once (`Authorization:
 * Bearer` instead of `X-Forge-Token`), so this helper exists to make the header a fact
 * checked in one place instead of retyped at every call site.
 */
import { readFileSync } from 'node:fs';

import { serverTokenPath } from './paths.js';

export const REQUEST_TIMEOUT_MS = 10_000;

/** A caller's own ceiling for one request, or the default. `FORGE_REQUEST_TIMEOUT_MS`
 *  overrides both, so a specimen can force a timeout without waiting ten seconds. */
export function requestTimeoutMs(wanted: number = REQUEST_TIMEOUT_MS): number {
  const raw = process.env['FORGE_REQUEST_TIMEOUT_MS'];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : wanted;
}

export interface ServerRequestResult {
  ok: boolean;
  status?: number;
  body?: unknown;
  /** Set when the request never reached the server at all (connection refused, timeout) --
   *  the "forge up is not running" case, distinct from a real HTTP error status. */
  down?: boolean;
  error?: string;
}

function forgePort(): number {
  const raw = process.env['FORGE_PORT'];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : 4120;
}

/** GET/POST against the running `forge up` server, with the auth header and timeout every
 *  caller needs. `fetchFn` is a specimen-only override; production leaves it unset and
 *  gets the global `fetch`. */
export async function serverRequest(
  path: string,
  init: RequestInit = {},
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<ServerRequestResult> {
  let token: string;
  try {
    token = readFileSync(serverTokenPath(), 'utf8').trim();
  } catch {
    return { ok: false, down: true, error: 'forge up is not running on 4120' };
  }
  const controller = new AbortController();
  const ceiling = requestTimeoutMs(timeoutMs);
  const timer = setTimeout(() => controller.abort(), ceiling);
  try {
    const response = await fetchFn(`http://127.0.0.1:${forgePort()}${path}`, {
      ...init,
      headers: { ...init.headers, 'x-forge-token': token },
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { ok: response.ok, status: response.status, body };
  } catch {
    // A request the server did not answer in time is not the same fact as no server:
    // the route may be doing real work (a gh read, a journal replay). Say which.
    if (controller.signal.aborted) {
      return { ok: false, down: true, error: `forge up did not answer ${path} in ${Math.round(ceiling / 1000)}s` };
    }
    return { ok: false, down: true, error: 'forge up is not running on 4120' };
  } finally {
    clearTimeout(timer);
  }
}
