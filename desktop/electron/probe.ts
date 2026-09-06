/**
 * The real port probe and the real wait loop, kept out of `console-supervisor.ts`
 * so that module stays free of timers and sockets.
 */
import http from 'node:http';
import type { ProbeResult } from './console-supervisor';

const HOST = '127.0.0.1';
const PORT = 4120;

export function probeConsole(): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const request = http.get({ host: HOST, port: PORT, path: '/state', timeout: 1500 }, (response) => {
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
