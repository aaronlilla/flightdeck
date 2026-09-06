#!/usr/bin/env -S npx tsx
/**
 * Load-verification harness for the Forge console (see `docs/load-verify.md`).
 *
 * Starts `forge up` against a throwaway `FORGE_HOME` this process builds with
 * `gen-forge-home.ts`, times the replay/startup, hits `/lanes`, `/journal`, `/proposals`
 * and `/integrations` a handful of times each, samples the server process's memory and
 * CPU while it answers, and writes one JSON result file per size. Never touches a real
 * `~/.forge`, never runs on port 4120, and never sets a fabricated `sessionId` or a real
 * brief path on a generated registry row -- see `gen-forge-home.ts` for why that matters
 * (a `forge up` reconcile or a Warden conformance check reaching a real model call would
 * be spend nobody decided).
 */
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

interface RunResult {
  label: string;
  runs: number;
  approxEvents: number;
  startupMs: number;
  endpoints: Record<string, { p50: number; p95: number; max: number; bytes: number; n: number }>;
  memRssMB: { atStart: number; atEnd: number };
  cpuPercentDuringLoad: number | null;
}

function repoRoot(): string {
  return process.cwd();
}

async function waitFor(url: string, timeoutMs: number): Promise<number> {
  const start = performance.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 401) return performance.now() - start;
    } catch {
      // not up yet
    }
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function timeEndpoint(
  url: string, headers: Record<string, string>, iterations: number,
): Promise<{ p50: number; p95: number; max: number; bytes: number; n: number }> {
  const times: number[] = [];
  let bytes = 0;
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    const res = await fetch(url, { headers });
    const text = await res.text();
    const t1 = performance.now();
    times.push(t1 - t0);
    bytes = Buffer.byteLength(text);
  }
  times.sort((a, b) => a - b);
  const pick = (p: number): number => times[Math.min(times.length - 1, Math.floor(times.length * p))]!;
  return { p50: Math.round(pick(0.5)), p95: Math.round(pick(0.95)), max: Math.round(times[times.length - 1]!), bytes, n: iterations };
}

/** Windows process memory/CPU sample via PowerShell (no extra dependency). CPU is
 *  total processor seconds consumed since start, converted to a percent over the
 *  sampling window by the caller. */
async function sampleProcess(pid: number): Promise<{ rssMB: number; cpuSeconds: number } | null> {
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      `Get-Process -Id ${pid} | Select-Object WorkingSet64,CPU | ConvertTo-Json`,
    ]);
    const parsed = JSON.parse(stdout) as { WorkingSet64: number; CPU: number };
    return { rssMB: Math.round(parsed.WorkingSet64 / (1024 * 1024)), cpuSeconds: parsed.CPU };
  } catch {
    return null;
  }
}

async function runOneSize(input: {
  label: string; runs: number; events: number | undefined; port: number; home: string; scratch: string;
}): Promise<RunResult> {
  const { label, runs, events, port, home } = input;
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });

  const genArgs = [
    '--experimental-strip-types', 'scripts/load/gen-forge-home.ts',
    '--home', home, '--runs', String(runs), '--seed', '11',
  ];
  if (events) genArgs.push('--events', String(events));
  await execFileAsync(process.execPath, genArgs, { cwd: repoRoot() });

  const env = { ...process.env, FORGE_HOME: home, FORGE_PORT: String(port) };
  // No shell: true here on purpose -- a shelled-out `npx tsx` spawns cmd.exe as the
  // direct child on Windows, so `child.pid` names the shell rather than the server, and
  // every memory/CPU sample below silently measured the wrong process (an 8MB RSS on
  // what is actually a running Node server was the tell). `cli.ts` imports its sibling
  // modules by `.js` specifier resolved to `.ts` files (tsx's own remap), which node's
  // native `--experimental-strip-types` does not do, so this loads tsx's own ESM loader
  // with `--import` instead of shelling out to its CLI -- still no intermediate shell,
  // and `child.pid` is the real server process.
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'src/forge/cli.ts', 'up'], {
    cwd: repoRoot(), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  const startupMs = await waitFor(`http://127.0.0.1:${port}/state`, 60_000);

  const memAtStart = await sampleProcess(child.pid!);

  const tokenRes = await fetch(`http://127.0.0.1:${port}/lanes`);
  // /lanes requires a bearer token; read it straight off the throwaway home the same way
  // a real client would, rather than guessing at the auth error body's shape.
  const tokenPath = join(home, 'server-token');
  const { readFileSync } = await import('node:fs');
  const token = readFileSync(tokenPath, 'utf8').trim();
  const headers = { 'X-Forge-Token': token };
  void tokenRes;

  const cpuBefore = await sampleProcess(child.pid!);
  const t0 = performance.now();

  const endpoints: RunResult['endpoints'] = {};
  endpoints['lanes'] = await timeEndpoint(`http://127.0.0.1:${port}/lanes?all=1`, headers, 8);
  endpoints['journal'] = await timeEndpoint(`http://127.0.0.1:${port}/journal?limit=200`, headers, 8);
  endpoints['proposals'] = await timeEndpoint(`http://127.0.0.1:${port}/proposals`, headers, 8);
  endpoints['integrations'] = await timeEndpoint(`http://127.0.0.1:${port}/integrations`, headers, 8);
  endpoints['state'] = await timeEndpoint(`http://127.0.0.1:${port}/state`, {}, 8);

  const t1 = performance.now();
  const cpuAfter = await sampleProcess(child.pid!);
  const memAtEnd = await sampleProcess(child.pid!);

  let cpuPercentDuringLoad: number | null = null;
  if (cpuBefore && cpuAfter) {
    const deltaCpuS = cpuAfter.cpuSeconds - cpuBefore.cpuSeconds;
    const wallS = (t1 - t0) / 1000;
    cpuPercentDuringLoad = wallS > 0 ? Math.round((deltaCpuS / wallS) * 100) : null;
  }

  // `shell: true` on Windows means `child.kill()` only kills the shell, not the `tsx`/
  // node process it spawned underneath -- the exact zombie-server trap this hit during
  // development (a killed benchmark run left the server bound to the port, and the next
  // run's `forge up` failed with EADDRINUSE). `taskkill /T` kills the whole tree.
  if (process.platform === 'win32' && child.pid) {
    try {
      await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    } catch {
      // Already gone.
    }
  } else {
    child.kill();
  }
  await new Promise((r) => setTimeout(r, 300));
  if (stderr.trim()) {
    console.error(`[${label}] stderr:\n${stderr.slice(0, 2000)}`);
  }

  return {
    label, runs, approxEvents: events ?? runs * 24, startupMs: Math.round(startupMs),
    endpoints,
    memRssMB: { atStart: memAtStart?.rssMB ?? -1, atEnd: memAtEnd?.rssMB ?? -1 },
    cpuPercentDuringLoad,
  };
}

async function main(): Promise<void> {
  const scratch = process.argv[2];
  if (!scratch) throw new Error('usage: run-benchmark.ts <scratch-dir>');
  const sizes: Array<{ label: string; runs: number; events?: number; port: number }> = [
    { label: 'lanes-10', runs: 10, port: 4131 },
    { label: 'lanes-100', runs: 100, port: 4132 },
    { label: 'lanes-500', runs: 500, port: 4133 },
    { label: 'lanes-2000', runs: 2000, port: 4134 },
    { label: 'journal-10k', runs: 200, events: 10_000, port: 4135 },
    { label: 'journal-100k', runs: 200, events: 100_000, port: 4136 },
    { label: 'journal-500k', runs: 200, events: 500_000, port: 4137 },
  ];
  const only = process.argv[3];
  const selected = only ? sizes.filter((size) => size.label === only) : sizes;
  const results: RunResult[] = [];
  for (const size of selected) {
    const home = join(scratch, `bench-${size.label}`);
    console.error(`--- running ${size.label} on port ${size.port} ---`);
    // eslint-disable-next-line no-await-in-loop
    const result = await runOneSize({
      label: size.label, runs: size.runs, events: size.events, port: size.port, home, scratch,
    });
    results.push(result);
    console.error(JSON.stringify(result, null, 2));
  }
  writeFileSync(join(scratch, 'bench-results.json'), JSON.stringify(results, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
