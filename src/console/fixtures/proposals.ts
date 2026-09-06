import type { Rule } from '../../shared/console-model.js';

export function seedRules(): Rule[] {
  return [
    {
      id: 'kill3', kind: 'cost', title: 'Kill a run after 3 consecutive failed builds',
      summary: 'FLT-204 would have stopped at 2.4M tokens · est. -178M tokens/week',
      evidence: 'FLT-204: 2 build failures in the last 30 minutes, 260k tokens/min burn, over its 1.6M token cap.',
      effect: 'Kills any run whose fails counter reaches 3, going forward.',
      status: 'open', jid: null, prUrl: null, expanded: true,
    },
    {
      id: 'autoans', kind: 'human wait', title: 'Auto-answer "NOT NULL on populated column" with backfill-first',
      summary: 'answered "backfill first" 4/4 this week · saves ≈44 min/week',
      evidence: 'BBZ-118 and one closed run both asked the identical migration-column question.',
      effect: 'Answers "nullable + backfill" automatically the next time this question is asked.',
      status: 'open', jid: null, prUrl: null,
    },
    {
      id: 'parallel-judges', kind: 'speed', title: 'Run the 3 council judges in parallel',
      summary: 'gate 9m → 3m · -6m per merge · same cost',
      evidence: 'Sequential judge lenses added 4 minutes to every gate over the last day.',
      effect: 'Opens a draft PR that runs the council lenses in parallel.',
      status: 'open', jid: null, prUrl: 'https://example.invalid/pr/240',
    },
  ];
}
