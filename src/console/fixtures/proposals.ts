import type { Rule } from '../../shared/console-model.js';

export function seedRules(): Rule[] {
  return [
    {
      id: 'kill3', kind: 'kill-after-fails', title: 'Kill a lane after 3 failed builds',
      summary: 'FLT-204 has failed twice today and is still running.',
      evidence: 'FLT-204: 2 build failures in the last 30 minutes, $1.30/min burn, over its $8 cap.',
      effect: 'Kills any run whose fails counter reaches 3, going forward.',
      status: 'open', jid: null, prUrl: null,
    },
    {
      id: 'autoans', kind: 'auto-answer', title: 'Auto-answer the recurring migration question',
      summary: 'The same NOT NULL / nullable question has been asked twice this week.',
      evidence: 'BBZ-118 and one closed run both asked the identical migration-column question.',
      effect: 'Answers "nullable + backfill" automatically the next time this question is asked.',
      status: 'open', jid: null, prUrl: null,
    },
    {
      id: 'parallel-judges', kind: 'self-iteration', title: 'Parallelize the council judges',
      summary: 'Gate runs finish faster when the three judge lenses run concurrently.',
      evidence: 'Sequential judge lenses added 4 minutes to every gate over the last day.',
      effect: 'Opens a draft PR that runs the council lenses in parallel.',
      status: 'open', jid: null, prUrl: 'https://example.invalid/pr/240',
    },
  ];
}
