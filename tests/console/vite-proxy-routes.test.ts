import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import config from '../../vite.console.config.js';

// The dev server proxies by path prefix. A route the client calls that is not in the
// list comes back as index.html, which the poll loop counts as a failed fetch and, after
// two of them, as the fleet server being unreachable.
describe('vite dev proxy', () => {
  it('covers every route src/console/api.ts calls', () => {
    const api = readFileSync(new URL('../../src/console/api.ts', import.meta.url), 'utf8');
    const called = new Set<string>();
    for (const match of api.matchAll(/\b(?:call|post|get)<[^>]*>\(\s*`?['"]?(\/[a-z-]+)/g)) called.add(match[1]!);
    expect(called.size).toBeGreaterThan(5);
    const proxied = Object.keys(config.server?.proxy ?? {});
    const missing = [...called].filter((route) => !proxied.includes(route));
    expect(missing).toEqual([]);
    expect(proxied).toContain('/events');
  });
});
