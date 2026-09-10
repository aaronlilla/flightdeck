/**
 * The real process table `sweep.ts` needs, read once per sweep with a single
 * `Get-CimInstance Win32_Process` call (the guardrail's own words) rather than one call
 * per candidate. Kept out of `sweep.ts` itself so that module stays fully injectable and
 * never shells out in a test.
 */
import { execFileSync } from 'node:child_process';

import type { ProcessRow } from '../sweep.js';

interface RawRow {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  CreationDate?: string;
}

/** Real production process table on Windows: one `Get-CimInstance` call, JSON out.
 *  `now` is injected only so a test could freeze age math; production never overrides it. */
export function realProcessTable(now: () => number = Date.now): ProcessRow[] {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate | ConvertTo-Json -Compress";
  const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const parsed: RawRow | RawRow[] = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const nowMs = now();
  return rows.map((row) => ({
    pid: row.ProcessId,
    ppid: row.ParentProcessId,
    name: row.Name,
    ageMs: row.CreationDate ? Math.max(0, nowMs - Date.parse(row.CreationDate)) : 0,
  }));
}
