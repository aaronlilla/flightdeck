/**
 * The real port probe and the real wait loop, kept out of `console-supervisor.ts`
 * so that module stays free of timers and sockets.
 *
 * `probeHealth()` (item 1, 2026-09-10) replaces liveness-only probing: "any HTTP
 * answer counts as up" misread the stale hand-run console on 4120 as reachable
 * while it was still 15-33s per request, and could never tell a genuinely foreign
 * process on the port from this app's own console. Four states instead of a
 * boolean:
 *
 * - `down`        -- nothing answered within the timeout, or the connection failed.
 * - `up-healthy`  -- `GET /health` answered 200 (or, against an older server with
 *                    no `/health` route, `/` answered 200 `text/html` carrying the
 *                    `forge-token` meta tag) -- the console page can actually load.
 * - `up-no-console` -- something forge-shaped answered (a `/state` 200, or a
 *                    `/health` 503) but the console page is not built yet.
 * - `up-foreign`  -- something answered that is not this server's shape at all
 *                    (wrong content type, no forge markers) -- a different
 *                    process altogether holds the port. Never treated as "up" for
 *                    attach purposes, and never a target this app revives or kills.
 */
import http from 'node:http';
import type { ProbeResult } from './console-supervisor';
import { consoleOrigin } from './console-origin';

const HOST = '127.0.0.1';
const HEALTH_TIMEOUT_MS = 10_000;

/** G5, 2026-09-10: the default port every probe in this file targets, resolved
 *  the same way the window's own load target is (`consoleOrigin`) -- so setting
 *  `FORGE_CONSOLE_ORIGIN` points the *entire* app (window load, health probe,
 *  the post-spawn wait loop) at a specimen server, not just the window. Without
 *  this, a live end-to-end test could load the window against a specimen but
 *  the supervisor's own attach/start decision would still probe the real 4120
 *  -- exactly what the guardrail against touching the live console exists to
 *  prevent. Read fresh on every call (never cached), so a test that sets the
 *  env var after this module has already loaded still takes effect. */
function defaultPort(): number {
  const port = new URL(consoleOrigin(process.env)).port;
  return port ? Number(port) : 4120;
}

export type HealthState = 'down' | 'up-no-console' | 'up-healthy' | 'up-foreign';

export interface HealthResult {
  health: HealthState;
}

interface RawResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function get(path: string, timeoutMs: number, port: number): Promise<RawResponse | undefined> {
  return new Promise((resolve) => {
    const request = http.get({ host: HOST, port, path, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      response.on('error', () => resolve(undefined));
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(undefined);
    });
    request.on('error', () => resolve(undefined));
  });
}

function looksLikeConsolePage(response: RawResponse): boolean {
  const contentType = String(response.headers['content-type'] ?? '');
  return response.statusCode === 200
    && contentType.includes('text/html')
    && response.body.includes('name="forge-token"');
}

/**
 * `probeHealth()` prefers `/health` (cheap, added by item 1's server change);
 * against a server old enough to have no `/health` route (a 404 for that path,
 * never a forge server's own 404 shape since forge's own 404s are JSON), it
 * falls back to `/state` (proves the process is a forge server) plus `/` (proves
 * the page loads) so this app still works against a console it has not yet
 * restarted onto the new build.
 */
export async function probeHealth(timeoutMs = HEALTH_TIMEOUT_MS, port = defaultPort()): Promise<HealthResult> {
  const health = await get('/health', timeoutMs, port);
  if (health && (health.statusCode === 200 || health.statusCode === 503)) {
    // A 200 or 503 alone is not proof: some other process could happen to
    // answer either on this path. Only trust it once the body is this
    // server's actual /health shape (`{ consoleBuilt: boolean }`) -- anything
    // else falls through to the /state check below so a genuinely different
    // process is not mistaken for a forge server.
    let isForgeHealth = false;
    try {
      const parsed = JSON.parse(health.body) as Record<string, unknown>;
      isForgeHealth = typeof parsed['consoleBuilt'] === 'boolean';
    } catch {
      isForgeHealth = false;
    }
    if (isForgeHealth) {
      return { health: health.statusCode === 200 ? 'up-healthy' : 'up-no-console' };
    }
  }

  const state = await get('/state', timeoutMs, port);
  if (!state || state.statusCode !== 200) {
    // Nothing answered /health and nothing forge-shaped answered /state either:
    // either nothing is listening (down) or something else is (foreign). A
    // connection failure (state undefined) reads as down; a real HTTP answer
    // that is not forge-shaped reads as foreign.
    return { health: state ? 'up-foreign' : 'down' };
  }
  let looksForge = false;
  try {
    const parsed = JSON.parse(state.body) as Record<string, unknown>;
    looksForge = typeof parsed['build'] === 'string' || typeof parsed['at'] === 'number';
  } catch {
    looksForge = false;
  }
  if (!looksForge) return { health: 'up-foreign' };

  const root = await get('/', timeoutMs, port);
  if (root && looksLikeConsolePage(root)) return { health: 'up-healthy' };
  return { health: 'up-no-console' };
}

export function probeConsole(): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const request = http.get({ host: HOST, port: defaultPort(), path: '/state', timeout: 1500 }, (response) => {
      response.resume();
      resolve({ reachable: true });
    });
    request.on('timeout', () => {
      request.destroy();
      resolve({ reachable: false });
    });
    request.on('error', () => resolve({ reachable: false }));
  });
}

export async function waitUntilReachable(
  probe: () => Promise<ProbeResult>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result.reachable) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Same wait shape as `waitUntilReachable`, but for the health-aware probe: polls
 *  until `up-healthy`, since that is the only state the app should ever load the
 *  page against. */
export async function waitUntilHealthy(
  probe: () => Promise<HealthResult>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result.health === 'up-healthy') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
