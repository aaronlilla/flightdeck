/**
 * The fixture stub server cut 1 builds, screenshots and tests against in
 * place of the real forge server. Runs under the default node environment,
 * same as the rest of the non-console suite: this file never touches the
 * DOM.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let server: Server;
let port: number;
let distDir: string;
let previousIndexHtml: string | undefined;

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const body = await response.json().catch(() => undefined);
  return { status: response.status, body };
}

beforeEach(async () => {
  // `stub-server.ts` reads its dist directory relative to itself, two levels
  // up. There is no way to point it at a temp directory without changing
  // that path, so a fixture `dist/console/index.html` stands in for a real
  // build here, saved and restored around the test instead of faking the
  // module's own layout.
  const here = fileURLToPath(new URL('../../src/console/', import.meta.url));
  distDir = join(here, '..', '..', 'dist', 'console');
  mkdirSync(distDir, { recursive: true });
  const indexPath = join(distDir, 'index.html');
  previousIndexHtml = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : undefined;
  writeFileSync(
    indexPath,
    '<html><head><meta name="forge-token" content="" /></head><body>stub</body></html>',
  );
  const mod = await import('../../src/console/stub-server.js');
  server = mod.createStubServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const indexPath = join(distDir, 'index.html');
  if (previousIndexHtml === undefined) rmSync(indexPath, { force: true });
  else writeFileSync(indexPath, previousIndexHtml);
});

describe('console stub server', () => {
  it('injects the stub token into index.html', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const text = await response.text();
    expect(text).toContain('content="stub-token"');
  });

  it('serves a fleet state and an open inbox entry', async () => {
    const state = await json('/state');
    expect(state.status).toBe(200);
    expect((state.body as { lanes: { value: unknown[] } }).lanes.value.length).toBeGreaterThan(0);

    const inbox = await json('/inbox');
    expect(inbox.status).toBe(200);
    expect((inbox.body as { open: unknown[] }).open.length).toBe(1);
  });

  it('answers a question and the entry leaves /inbox open', async () => {
    const answered = await json('/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'a1b2c3d4e5f60718', answer: 'dev' }),
    });
    expect(answered.status).toBe(200);

    const inbox = await json('/inbox');
    expect((inbox.body as { open: unknown[] }).open).toEqual([]);
  });

  it('accepts /stop, /send and /clear', async () => {
    expect((await json('/stop', { method: 'POST' })).status).toBe(200);
    expect((await json('/send', { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await json('/clear', { method: 'POST', body: '{}' })).status).toBe(200);
  });
});
