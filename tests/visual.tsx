/**
 * Render every interface state to stdout so a person can look at it.
 *
 * Standing order 4: before presenting a visual result, look at the artifact in
 * the environment that ships. For a terminal application that means the frames
 * themselves, not the source that produces them. This spends nothing and
 * starts no session, so it can be run at any time.
 */
import { Box, render, Text } from 'ink';
import React from 'react';

import { ApprovalView, InputLine, StatusBarView, StreamView } from '../src/cockpit/components.tsx';
import { buildStatusBar } from '../src/cockpit/format.ts';
import type { Entry } from '../src/cockpit/entries.ts';
import { initialSessionState, type KernelHealth } from '../src/types.ts';
import { NONE_OF_THREE } from './specimens/convergence.ts';

const healthy: KernelHealth = { healthy: true, disabled: [], failures: [] };
const broken: KernelHealth = {
  healthy: false,
  disabled: ['authorship'],
  failures: ['authorship: cannot read property of undefined'],
};

const entries: Entry[] = [
  { kind: 'user', id: 1, text: 'add a retry to the fetch helper' },
  {
    kind: 'assistant',
    id: 2,
    text: 'I will add a bounded retry with jitter inside the helper so every caller inherits it.',
  },
  {
    kind: 'tool',
    id: 3,
    toolId: 't1',
    name: 'Read',
    input: { file_path: 'src/api/fetch.ts' },
    status: 'done',
  },
  {
    kind: 'tool',
    id: 4,
    toolId: 't2',
    name: 'Agent',
    input: { subagent_type: 'Explore', model: 'sonnet' },
    status: 'running',
  },
  {
    kind: 'note',
    id: 5,
    note: {
      guard: 'subagent-tier',
      severity: 'info',
      message: 'Subagent Explore belongs on sonnet, and the call named no model. Corrected.',
    },
  },
  {
    kind: 'tool',
    id: 6,
    toolId: 't3',
    name: 'Write',
    input: { file_path: 'README.md' },
    status: 'denied',
  },
  {
    kind: 'system',
    id: 7,
    text: 'Machine authorship claimed in text that is about to reach another person.',
    tone: 'warn',
  },
];

function Divider({ label }: { label: string }): React.ReactElement {
  return (
    <Box marginTop={1} marginBottom={1}>
      <Text color="magenta" bold>
        {`──── ${label} `.padEnd(74, '─')}
      </Text>
    </Box>
  );
}

function Gallery(): React.ReactElement {
  const planning = buildStatusBar(
    { ...initialSessionState('/repo'), phase: 'planning', selectedModel: 'claude-fable-5', permissionMode: 'plan', sessionId: '3f2a9c1e-aaaa' },
    healthy,
    128000,
  );
  const rerouted = buildStatusBar(
    {
      ...initialSessionState('/repo'),
      phase: 'implementation',
      selectedModel: 'claude-fable-5',
      servingModel: 'claude-opus-4-8',
      sessionId: '3f2a9c1e-aaaa',
    },
    healthy,
    64000,
  );
  const degraded = buildStatusBar(
    { ...initialSessionState('/repo'), phase: 'implementation', selectedModel: 'claude-opus-5' },
    broken,
    12000,
  );

  return (
    <Box flexDirection="column">
      <Divider label="conversation stream" />
      <StreamView entries={entries} />

      <Divider label="input line with the slash palette open" />
      <InputLine value="/p" busy={false} />

      <Divider label="input line while a turn is running" />
      <InputLine value="" busy />

      <Divider label="status bar: planning" />
      <StatusBarView bar={planning} />

      <Divider label="status bar: the answering model is not the one asked for" />
      <StatusBarView bar={rerouted} />

      <Divider label="status bar: a guard has failed" />
      <StatusBarView bar={degraded} />

      <Divider label="approval: a file write" />
      <ApprovalView
        request={{
          call: {
            toolName: 'Edit',
            input: {
              file_path: 'src/api/fetch.ts',
              old_string: 'return fetch(url);',
              new_string: 'return withRetry(() => fetch(url), { attempts: 3 });',
            },
          },
          notes: [],
          isPlanApproval: false,
        }}
        onDecide={() => {}}
        interactive={false}
      />

      <Divider label="approval: a plan the convergence guard objected to" />
      <ApprovalView
        request={{
          call: { toolName: 'ExitPlanMode', input: { plan: NONE_OF_THREE.split('\n').slice(0, 8).join('\n') } },
          notes: [
            {
              guard: 'convergence',
              severity: 'blocking',
              message: 'This plan does not carry: alternatives, falsifier, unknowns.',
            },
            {
              guard: 'convergence',
              severity: 'blocking',
              message: 'No falsifier. Write the one sentence: this is wrong if X.',
            },
          ],
          isPlanApproval: true,
        }}
        onDecide={() => {}}
        interactive={false}
      />
    </Box>
  );
}

const instance = render(<Gallery />);
// One frame is enough. Nothing here is interactive.
setTimeout(() => instance.unmount(), 120);
