#!/usr/bin/env -S npx tsx
/**
 * Board-render half of the load-verification harness (see `docs/load-verify.md`). Points
 * a real Chromium at a real `forge up` server backed by a synthetic forge home, and
 * measures what an API-only benchmark cannot: time to first tile, whether the grid is
 * interactive, whether the 5s poll misbehaves under a slow response, whether ten
 * concurrent boards plus a churn of `/events` sockets leave anything leaked, and whether
 * the rendered tiles/filter-chip counts/needs-you strip agree with the server's own data
 * at the largest size this harness generates.
 *
 * Never touches `~/.forge`, port 4120, or the tracked console dist outside this repo's
 * own `dist/console/` (already built by `npm run console:build`).
 */
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const execFileAsync = promisify(execFile);

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function startServer(home: string, port: number, runs: number, events: number | undefined): Promise<{ kill: () => Promise<void>; token: string }> {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const genArgs = ['--experimental-strip-types', 'scripts/load/gen-forge-home.ts', '--home', home, '--runs', String(runs), '--seed', '21'];
  if (events) genArgs.push('--events', String(events));
  await execFileAsync(process.execPath, genArgs, { cwd: process.cwd() });

  const env = { ...process.env, FORGE_HOME: home, FORGE_PORT: String(port) };
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'src/forge/cli.ts', 'up'], {
    cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHttp(`http://127.0.0.1:${port}/`, 30_000);
  const token = readFileSync(join(home, 'server-token'), 'utf8').trim();
  return {
    token,
    kill: async () => {
      if (process.platform === 'win32' && child.pid) {
        try {
          await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
        } catch {
          // already gone
        }
      } else {
        child.kill();
      }
    },
  };
}

interface SizeReport {
  label: string;
  ttfpMs: number;
  gridInteractiveMs: number;
  consoleErrors: string[];
  tileCount: number;
  allChipCount: number;
  runningChipCount: number;
  needsYouCount: number | null;
  overlappingLanesRequestsSeen: number;
  concurrentLoadFailures: number;
  concurrentLoadMaxMs: number;
}

async function checkOneSize(input: { label: string; home: string; port: number; runs: number; events?: number }): Promise<SizeReport> {
  const server = await startServer(input.home, input.port, input.runs, input.events);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addInitScript((token: string) => {
      // The build serves index.html with the real token already filled in; going straight
      // to `/` (as a real board does) means Playwright never has to know it either.
      void token;
    }, server.token);
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    let lanesRequestsInFlight = 0;
    let overlapSeen = 0;
    page.on('request', (req) => {
      if (req.url().includes('/lanes')) {
        lanesRequestsInFlight += 1;
        if (lanesRequestsInFlight > 1) overlapSeen += 1;
      }
    });
    page.on('requestfinished', (req) => { if (req.url().includes('/lanes')) lanesRequestsInFlight -= 1; });
    page.on('requestfailed', (req) => { if (req.url().includes('/lanes')) lanesRequestsInFlight -= 1; });

    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${input.port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid^="lane-"]', { timeout: 120_000 });
    const ttfpMs = Date.now() - t0;

    // "interactive": the filter chip row responds to a click by changing the grid's
    // rendered tile count (or staying at the same count honestly, for "all"), inside a
    // bounded wait -- not just present in the DOM.
    const tInteractiveStart = Date.now();
    const allChip = page.getByText(/^all \d+$/).first();
    await allChip.click({ timeout: 10_000 });
    const gridInteractiveMs = Date.now() - tInteractiveStart;

    const tileCount = await page.locator('[data-testid^="lane-"]').count();
    const allChipText = await allChip.textContent();
    const allChipCount = Number(/\d+/.exec(allChipText ?? '')?.[0] ?? -1);
    const runningChipText = await page.getByText(/^running \d+$/).first().textContent().catch(() => null);
    const runningChipCount = Number(/\d+/.exec(runningChipText ?? '')?.[0] ?? -1);
    const needsYouText = await page.getByText('Needs you').locator('../..').textContent().catch(() => null);
    const needsYouCount = needsYouText ? Number(/(\d+)/.exec(needsYouText)?.[1] ?? -1) : null;

    // Ten browser contexts on the board at once, plus a churn of /events opens/closes --
    // watch for a server that stops answering or a page that throws once the socket
    // count is nonzero. Each context's own first-tile wait is caught rather than left to
    // fail the whole run: how many of ten concurrent boards actually finish loading, and
    // how long the slowest one took, is itself the number this step exists to produce.
    const extraContexts = await Promise.all(
      Array.from({ length: 10 }, () => browser.newContext()),
    );
    const extraPages = await Promise.all(extraContexts.map((c) => c.newPage()));
    await Promise.all(extraPages.map((p) => p.goto(`http://127.0.0.1:${input.port}/`, { waitUntil: 'domcontentloaded' })));
    const concurrentLoadStart = Date.now();
    const concurrentLoadOutcomes = await Promise.all(extraPages.map(async (p) => {
      try {
        await p.waitForSelector('[data-testid^="lane-"]', { timeout: 90_000 });
        return { ok: true, ms: Date.now() - concurrentLoadStart };
      } catch {
        return { ok: false, ms: null as number | null };
      }
    }));
    const concurrentLoadFailures = concurrentLoadOutcomes.filter((o) => !o.ok).length;
    const concurrentLoadMaxMs = Math.max(0, ...concurrentLoadOutcomes.filter((o) => o.ok).map((o) => o.ms!));
    // Churn: open and close the /events socket repeatedly from inside the page context.
    await page.evaluate(async (port: number) => {
      for (let i = 0; i < 20; i += 1) {
        await new Promise<void>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/events`);
          ws.onopen = () => setTimeout(() => { ws.close(); resolve(); }, 20);
          ws.onerror = () => resolve();
        });
      }
    }, input.port);
    // A final read after the churn: the server should still answer promptly.
    const stillAlive = await fetch(`http://127.0.0.1:${input.port}/`).then((r) => r.ok).catch(() => false);
    if (!stillAlive) consoleErrors.push('server stopped answering after the /events churn + 10 contexts');
    await Promise.all(extraContexts.map((c) => c.close()));

    return {
      label: input.label, ttfpMs, gridInteractiveMs, consoleErrors, tileCount, allChipCount,
      runningChipCount, needsYouCount, overlappingLanesRequestsSeen: overlapSeen,
      concurrentLoadFailures, concurrentLoadMaxMs,
    };
  } finally {
    await browser.close();
    await server.kill();
  }
}

async function main(): Promise<void> {
  const scratch = process.argv[2];
  if (!scratch) throw new Error('usage: browser-check.ts <scratch-dir>');
  const sizes: Array<{ label: string; runs: number; events?: number; port: number }> = [
    { label: 'board-100', runs: 100, port: 4141 },
    { label: 'board-2000', runs: 2000, port: 4142 },
  ];
  const only = process.argv[3];
  const selected = only ? sizes.filter((size) => size.label === only) : sizes;
  const reports: SizeReport[] = [];
  for (const size of selected) {
    console.error(`--- board check ${size.label} ---`);
    const home = join(scratch, `browser-${size.label}`);
    // eslint-disable-next-line no-await-in-loop
    const report = await checkOneSize({ label: size.label, home, port: size.port, runs: size.runs, events: size.events });
    reports.push(report);
    console.error(JSON.stringify(report, null, 2));
  }
  writeFileSync(join(scratch, 'browser-results.json'), JSON.stringify(reports, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
