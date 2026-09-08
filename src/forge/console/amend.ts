/**
 * The one amend implementation behind `POST /amend` and the Conductor agent's
 * `amend_run` tool (2026-09-08). The text lands in the brief file as a dated
 * `## Amendment` section and inside `## Definition of Done`, so the drift check re-reads
 * it, and once more through the run's own inbox so the current turn hears it now.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { appendOnce } from '../journal.js';
import type { Registry } from '../registry.js';
import { RunInbox } from '../runinbox.js';

export interface AmendDeps {
  registry: Registry;
  journalPath: string;
  publish: (event: Record<string, unknown>) => void;
}

export type AmendOutcome =
  | { status: 200; body: { ok: true } }
  | { status: 404; body: { error: string } };

/**
 * Same two regexes `conformance-drift.ts` uses to find and bound a brief's own
 * `## Definition of Done` section (duplicated rather than imported, since that module
 * belongs to the drift checker and this one only needs the same shape). `appendAmendment`
 * folds an amendment's text into that section -- the section the drift checker re-reads
 * every tick -- and also appends a dated `## Amendment` section so a later reader can see
 * the brief was corrected after the fact, rather than only see a Definition of Done that
 * quietly grew.
 */
const DOD_HEADING = /^##[ \t]+Definition of Done[ \t]*\r?\n/im;
const NEXT_HEADING = /^##[ \t]+\S/m;

/** Exported for its own specimen; used by `/amend` and `amend_run`. */
export function appendAmendment(brief: string, text: string): string {
  const stamp = new Date().toISOString();
  const start = DOD_HEADING.exec(brief);
  let withDoD = brief;
  if (start) {
    const bodyStart = start.index + start[0].length;
    const rest = brief.slice(bodyStart);
    NEXT_HEADING.lastIndex = 0;
    const next = NEXT_HEADING.exec(rest);
    const insertAt = bodyStart + (next ? next.index : rest.length);
    const before = brief.slice(0, insertAt);
    const after = brief.slice(insertAt);
    const needsBlankLine = !before.endsWith('\n\n') && !before.endsWith('\n');
    withDoD = `${before}${needsBlankLine ? '\n' : ''}- Amendment (${stamp}): ${text}\n${after}`;
  }
  const separator = withDoD.endsWith('\n') ? '\n' : '\n\n';
  return `${withDoD}${separator}## Amendment (${stamp})\n\n${text}\n`;
}

export function amendRunBrief(run: string, text: string, deps: AmendDeps): AmendOutcome {
  const record = deps.registry.get(run);
  if (!record) return { status: 404, body: { error: `nothing runs ${run}` } };
  const brief = readFileSync(record.briefPath, 'utf8');
  writeFileSync(record.briefPath, appendAmendment(brief, text), 'utf8');
  new RunInbox(run).send(`Amendment: ${text}`, 'console');
  appendOnce(deps.journalPath, { event: 'brief.amended', run, actor: 'console', text });
  deps.publish({ event: 'brief.amended', run });
  return { status: 200, body: { ok: true } };
}
