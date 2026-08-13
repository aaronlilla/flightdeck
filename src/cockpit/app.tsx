/**
 * The root component: it owns the wiring between the engine, the kernel and
 * the screen.
 *
 * The awkward join is the permission request. The engine asks a question and
 * waits on a promise, while the screen answers it several keystrokes later, so
 * the request is parked in state with its resolver and released when Aaron
 * presses a key. Everything else is a straight subscription.
 */
import { Box, Text, useApp } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Engine } from '../adapter/engine.ts';
import type { EngineEvent } from '../adapter/events.ts';
import { Kernel, type ApprovalRequest } from '../kernel/kernel.ts';
import { authorshipGuard } from '../kernel/guards/authorship.ts';
import { convergenceGuard } from '../kernel/guards/convergence.ts';
import { createSycophancyGuard, type Turn } from '../kernel/guards/sycophancy.ts';
import { subagentTierGuard } from '../kernel/guards/subagent-tier.ts';
import { createVaguenessGuard } from '../kernel/guards/vagueness.ts';
import { loadOverlays } from '../overlay/overlays.ts';
import type { GuardNote } from '../types.ts';
import { ApprovalView, InputLine, StatusBarView, StreamView, useLineEditor } from './components.tsx';
import { nextId, type Entry } from './entries.ts';
import { buildStatusBar } from './format.ts';

interface Pending {
  request: ApprovalRequest;
  resolve: (allow: boolean) => void;
}

export function App({ cwd, resume }: { cwd: string; resume?: string }): React.ReactElement {
  const { exit } = useApp();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [contextLeft, setContextLeft] = useState<number | null>(null);

  const bump = () => setVersion((v) => v + 1);
  const push = (entry: Entry) => setEntries((list) => [...list, entry]);
  const say = (text: string, tone: 'info' | 'warn' | 'error' = 'info') =>
    push({ kind: 'system', id: nextId(), text, tone });
  const note = (n: GuardNote) => push({ kind: 'note', id: nextId(), note: n });

  // The transcript the sycophancy guard reads, kept alongside the display list
  // because it needs turns rather than rendered entries.
  const turns = useRef<Turn[]>([]);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  const { engine, kernel, overlays } = useMemo(() => {
    const engine = new Engine();
    const overlays = loadOverlays();
    const kernel = new Kernel({
      cwd,
      controls: {
        setModel: (model) => engine.setModel(model),
        setPermissionMode: (mode) => engine.setPermissionMode(mode),
      },
      onNote: note,
      approve: (request) =>
        new Promise((resolve) => {
          setPending({ request, resolve: (allow) => resolve(allow ? { allow: true } : { allow: false, reason: 'declined' }) });
        }),
      guards: [
        authorshipGuard,
        subagentTierGuard,
        convergenceGuard,
        createSycophancyGuard(
          () => turns.current,
          (message) => note({ guard: 'sycophancy', severity: 'warning', message }),
        ),
        // No classifier is wired, so this one only ever reports that a prompt
        // looked underspecified. Stage two costs a model call and spending
        // traces to a decision.
        createVaguenessGuard(null, (message) =>
          note({ guard: 'vagueness', severity: 'info', message }),
        ),
      ],
    });
    return { engine, kernel, overlays };
  }, [cwd]);

  useEffect(() => {
    const off = engine.onEvent((event: EngineEvent) => {
      handle(event);
      bump();
    });

    engine.start({
      cwd,
      // Guards run here, because a tool an existing permission rule already
      // allows never reaches the permission callback at all.
      onToolCall: ({ toolName, input, toolUseId }) => {
        const verdict = kernel.inspect({ toolName, input }, toolUseId);
        if (verdict.decision === 'deny') {
          push({
            kind: 'tool',
            id: nextId(),
            toolId: `denied-${toolUseId}`,
            name: toolName,
            input,
            status: 'denied',
          });
          say(verdict.reason ?? 'refused by a guard', 'warn');
        }
        const out: { decision: 'deny' | 'ask' | undefined; reason?: string; updatedInput?: Record<string, unknown> } = {
          decision: verdict.decision,
        };
        if (verdict.reason) out.reason = verdict.reason;
        if (verdict.updatedInput) out.updatedInput = verdict.updatedInput;
        return out;
      },
      // The permission callback is the human's decision and nothing else.
      canUseTool: async (toolName, input, options) => {
        const decision = await kernel.decide({ toolName, input }, options.toolUseID);
        return decision.allow
          ? { behavior: 'allow', updatedInput: decision.input ?? input }
          : { behavior: 'deny', message: decision.reason };
      },
      ...(resume ? { resume } : {}),
    });

    if (overlays.problems.length) {
      for (const problem of overlays.problems) say(`overlay: ${problem}`, 'warn');
    }
    if (overlays.overlays.length) {
      say(`overlays loaded: ${overlays.overlays.map((o) => o.name).join(', ')}`);
    }

    return () => {
      off();
      void engine.stop();
    };
    // Engine and kernel are created once and intentionally outlive renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handle(event: EngineEvent): void {
    switch (event.type) {
      case 'session-started':
        kernel.state.sessionId = event.sessionId;
        kernel.state.selectedModel ??= event.model;
        say(`session ${event.sessionId.slice(0, 8)} on ${event.model}`);
        break;
      case 'assistant-text':
        push({ kind: 'assistant', id: nextId(), text: event.text });
        turns.current.push({ role: 'assistant', text: event.text });
        kernel.recordServingModel(event.model);
        break;
      case 'thinking':
        push({ kind: 'thinking', id: nextId(), text: event.text });
        break;
      case 'tool-use':
        push({
          kind: 'tool',
          id: nextId(),
          toolId: event.id,
          name: event.name,
          input: event.input,
          status: 'running',
        });
        // A tool ran, which is what separates a considered change of mind from
        // a fold under pressure.
        for (let i = turns.current.length - 1; i >= 0; i -= 1) {
          const turn = turns.current[i];
          if (turn?.role === 'assistant') {
            turn.usedTool = true;
            break;
          }
        }
        break;
      case 'tool-result':
        setEntries((list) =>
          list.map((entry) =>
            entry.kind === 'tool' && entry.toolId === event.id
              ? { ...entry, status: event.isError ? 'error' : 'done', result: event.text }
              : entry,
          ),
        );
        break;
      case 'turn-complete':
        setBusy(false);
        kernel.state.turnCount += 1;
        setContextLeft(event.contextRemaining);
        kernel.observe({ type: 'turn-complete', model: kernel.state.servingModel });
        if (event.isError) say(`turn ended with an error (${event.subtype})`, 'error');
        break;
      case 'compact-boundary':
        say('context compacted; earlier turns are summarised from here', 'warn');
        break;
      case 'engine-error':
        setBusy(false);
        say(event.message, 'error');
        break;
      case 'stderr':
        if (event.text.trim()) say(event.text.trim(), 'warn');
        break;
      default:
        break;
    }
  }

  async function submit(text: string): Promise<void> {
    push({ kind: 'user', id: nextId(), text });

    if (text.startsWith('/')) {
      const handled = await runCommand(text);
      bump();
      if (handled) return;
    }

    turns.current.push({ role: 'user', text });
    kernel.observe({ type: 'prompt', text });
    setBusy(true);
    engine.send(text);
  }

  /** Commands the app answers itself. Returns false to pass the text onward. */
  async function runCommand(text: string): Promise<boolean> {
    const [command, ...rest] = text.trim().split(/\s+/);
    const argument = rest.join(' ');
    switch (command) {
      case '/plan':
        await kernel.enterPlanning();
        say('planning phase: plan mode on, model switched to the plan tier');
        return true;
      case '/build':
        await kernel.leavePlanning();
        say('left plan mode');
        return true;
      case '/model':
        if (!argument || argument === 'auto') {
          await kernel.overrideModel(null);
          say('model pin cleared; the phase router decides again');
        } else {
          await kernel.overrideModel(argument);
          say(`model pinned to ${argument} until cleared with /model auto`);
        }
        return true;
      case '/phase': {
        const required = kernel.requiredModel();
        say(`phase ${kernel.state.phase}, ${required ? `requires ${required}` : 'no model required'}`);
        return true;
      }
      case '/overlays':
        say(
          overlays.overlays.length
            ? overlays.overlays.map((o) => `${o.name} at ${o.root}`).join('\n')
            : `no overlays (manifest would be ${overlays.manifestPath})`,
        );
        return true;
      case '/health': {
        const health = kernel.health;
        say(
          health.healthy
            ? 'every guard is running'
            : `UNCHECKED: ${health.failures.join('; ')}`,
          health.healthy ? 'info' : 'error',
        );
        return true;
      }
      case '/clear':
        setEntries([]);
        return true;
      case '/quit':
        void engine.stop().then(() => exit());
        return true;
      default:
        // Anything else is a skill or a custom command, which the engine
        // resolves from the filesystem itself.
        return false;
    }
  }

  const editor = useLineEditor((text) => void submit(text), pending === null);
  const bar = buildStatusBar(kernel.state, kernel.health, contextLeft);

  return (
    <Box flexDirection="column" key={version}>
      <StreamView entries={entries} />
      {pending ? (
        <Box marginTop={1}>
          <ApprovalView
            request={pending.request}
            onDecide={(allow) => {
              pending.resolve(allow);
              setPending(null);
            }}
          />
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <InputLine value={editor.value} busy={busy} />
        </Box>
      )}
      <Box marginTop={1}>
        <StatusBarView bar={bar} />
      </Box>
      {entries.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>type to begin · /plan to plan · /quit to leave</Text>
        </Box>
      ) : null}
    </Box>
  );
}
