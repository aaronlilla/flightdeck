/**
 * F30's remaining part: a decisions manifest for workers, feeding the `forge manifest`
 * command Console owns (`2026-09-04-forge-roadmap.md:157-158`). This stream owns the
 * manifest's content only -- what belongs in it and how it is computed -- never the CLI
 * surface that renders it; that command is Console's to wire up.
 *
 * A worker facing a park needs to know, in one place, which of the decisions blocking it
 * are already made and which are still open, without grepping the journal by hand. This
 * builds exactly that list from a set of targets the caller already knows are pending.
 */
import { readFileSync } from 'node:fs';

import { replayEvents } from '../contracts.js';

export interface PendingDecision {
  target: string;
  action: string;
}

export interface DecisionManifestEntry extends PendingDecision {
  decided: boolean;
  decisionId?: string;
  reason?: string;
}

export function buildDecisionsManifest(journalPath: string, pending: PendingDecision[]): DecisionManifestEntry[] {
  let text: string;
  try {
    text = readFileSync(journalPath, 'utf8');
  } catch {
    return pending.map((entry) => ({ ...entry, decided: false }));
  }
  const { events } = replayEvents(text);
  const decisions = events.filter((event) => event.event === 'decision.made');

  return pending.map((entry) => {
    const match = decisions.find((event) => event.run === entry.target && event['action'] === entry.action);
    if (!match) return { ...entry, decided: false };
    return { ...entry, decided: true, decisionId: match.id, reason: match['reason'] as string | undefined };
  });
}
