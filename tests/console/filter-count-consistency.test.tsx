// @vitest-environment jsdom
/**
 * Fidelity sweep #2: the server windows finished lanes older than 24 hours out of
 * `GET /lanes` unless the request carries `all=1` (src/forge/console/reads.ts,
 * `windowLanes`). Once a fleet passes 12 lanes the console auto-switches its active
 * filter to the hidden "today" view (store.ts POLISH-2 #4) using whatever lane set it
 * already has in memory -- if that set came from the unwindowed `all=1` fetch made on
 * first load, the "all" chip keeps advertising the full unwindowed total while the
 * board itself, now filtered to "today", renders fewer tiles. Every chip must instead
 * count exactly what clicking it would show.
 */
import { createServer, type Server } from 'node:http';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../src/console/App.js';
import type { Lane } from '../../src/shared/console-model.js';

class FakeSocket {
  onopen: (() => void) | null = null;

  onclose: (() => void) | null = null;

  onmessage: ((event: { data: string }) => void) | null = null;

  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  close(): void { this.onclose?.(); }

  send(): void {}
}

function baseLane(id: string, overrides: Partial<Lane>): Lane {
  const now = Date.now();
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id, ticket: null, model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 1000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 1, tokenCap: 10, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: now, verifiedAt: now, heart: false,
    since: now, startedAt: now, endedAt: null, question: null, pr: null, sandbox: null,
    blockedBy: null, runaway: false, needsAaron: null,
    ...overrides,
  };
}

let server: Server;
let base: string;
let originalFetch: typeof fetch;

// A fleet shaped like the real one: 6 lanes still worth showing today, plus 11 old
// finished lanes the server windows out of the default (non-`all=1`) response.
function buildFleet(): { full: Lane[]; windowed: Lane[] } {
  const now = Date.now();
  const twoDaysAgo = now - 48 * 3_600_000;
  const recent = Array.from({ length: 6 }, (_, i) => baseLane(`FLT-${i}`, { state: 'running', observedAt: now, since: now }));
  const oldFinished = Array.from({ length: 11 }, (_, i) => baseLane(`OLD-${i}`, {
    state: 'done', observedAt: twoDaysAgo, since: twoDaysAgo, endedAt: twoDaysAgo,
  }));
  return { full: [...recent, ...oldFinished], windowed: recent };
}

beforeEach(async () => {
  const { full, windowed } = buildFleet();
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/lanes') {
      const all = url.searchParams.get('all') === '1';
      response.end(JSON.stringify({ at: Date.now(), lanes: all ? full : windowed, tokensToday: 0, tokensPerMin: 0 }));
      return;
    }
    if (url.pathname === '/thread') { response.end(JSON.stringify({ messages: [] })); return; }
    if (url.pathname === '/journal') { response.end(JSON.stringify({ rows: [], total: 0 })); return; }
    if (url.pathname === '/integrations') { response.end(JSON.stringify({ items: [], checkedAt: Date.now(), everyS: 30 })); return; }
    if (url.pathname === '/caps') { response.end(JSON.stringify({ dailyTokens: 40, runTokens: 10, hardTokens: 100, tokensToday: 0 })); return; }
    if (url.pathname === '/proposals') {
      response.end(JSON.stringify({ rules: [], metrics: { mergedToday: 0, humanWaitMin: 0, tokensPerMerge: null, tokensWasted: 0 }, computedAt: Date.now() }));
      return;
    }
    if (url.pathname === '/queue') {
      response.end(JSON.stringify({ items: [], paused: false, maxInFlight: 2 }));
      return;
    }
    if (url.pathname === '/state') { response.end(JSON.stringify({ queue_on: true })); return; }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  originalFetch = global.fetch;
  global.fetch = ((input: RequestInfo | URL, init?: RequestInit) => originalFetch(`${base}${String(input)}`, init)) as typeof fetch;
});

afterEach(async () => {
  global.fetch = originalFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('filter chip counts vs the rendered board', () => {
  it('the "all" chip count always equals the number of lanes actually on the board when "all" is picked', async () => {
    render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
    await waitFor(() => expect(screen.getAllByTestId(/^lane-/).length).toBeGreaterThan(0));

    const allChip = screen.getByText(/^all \d+$/);
    const advertised = Number(/\d+/.exec(allChip.textContent ?? '')?.[0]);

    await userClicksAll(allChip);

    await waitFor(() => {
      expect(screen.getAllByTestId(/^lane-/).length).toBe(advertised);
    });
  });
});

async function userClicksAll(el: HTMLElement): Promise<void> {
  const { default: userEvent } = await import('@testing-library/user-event');
  await userEvent.click(el);
}
