import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function readToken(home) {
  return readFileSync(join(home, 'server-token'), 'utf8').trim();
}

export function readJournal(home) {
  const p = join(home, 'fleet.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function journalEventsForRun(home, run) {
  return readJournal(home).filter((e) => e.run === run);
}

export function lastCostForRun(home, run) {
  const events = journalEventsForRun(home, run);
  let cost;
  for (const e of events) {
    if (typeof e.costUsd === 'number') cost = e.costUsd;
    if (e.cost && typeof e.cost.usd === 'number') cost = e.cost.usd;
  }
  return cost;
}

export async function apiGet(port, token, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'x-forge-token': token } });
  return res.json();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(fn, { timeoutMs = 60000, intervalMs = 500, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await sleep(intervalMs);
  }
}
