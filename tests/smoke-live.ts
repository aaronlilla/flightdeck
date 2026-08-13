/**
 * The only test here that talks to a real session.
 *
 * It is run by hand and never by CI, because it spends real subscription usage
 * and spending traces to a decision. Everything else in this repository is
 * proved against fixtures and specimens; this exists because none of that can
 * tell you whether the thing actually connects.
 *
 * The first version of this file claimed a tool call had "reached the kernel"
 * while measuring only that a tool call had happened. It passed, and it was
 * wrong: the kernel was never consulted, because a permission rule already
 * allowed the tool and the permission callback is skipped in that case. The
 * checks below count what the kernel actually saw, and the last one asks the
 * live model to write something the authorship guard must refuse, so that the
 * refusal is observed rather than assumed.
 */
import { Engine } from '../src/adapter/engine.ts';
import type { EngineEvent } from '../src/adapter/events.ts';
import { Kernel } from '../src/kernel/kernel.ts';
import { authorshipGuard } from '../src/kernel/guards/authorship.ts';
import { subagentTierGuard } from '../src/kernel/guards/subagent-tier.ts';
import { TRAILER } from './specimens/authorship.ts';

const MARKER = 'flightdeck-live-ok';
const TURN_TIMEOUT_MS = 180_000;

const inspected: string[] = [];
const denied: string[] = [];
const log = (line: string) => console.log(`  ${line}`);

async function main(): Promise<void> {
  const engine = new Engine();
  let sessionId: string | null = null;
  let sawToolResult = false;
  let markerSeen = false;
  let assistantText = '';
  let servingModel: string | null = null;
  let resolveTurn: (() => void) | null = null;

  const kernel = new Kernel({
    cwd: process.cwd(),
    controls: {
      setModel: (model) => engine.setModel(model),
      setPermissionMode: (mode) => engine.setPermissionMode(mode),
    },
    onNote: (note) => log(`note [${note.guard}] ${note.message.split('\n')[0]}`),
    // Auto-approves whatever reaches the human. The approval screen is proven
    // separately against rendered frames; what matters here is the guard layer.
    approve: async () => ({ allow: true }),
    guards: [authorshipGuard, subagentTierGuard],
  });

  engine.onEvent((event: EngineEvent) => {
    switch (event.type) {
      case 'session-started':
        sessionId = event.sessionId;
        log(`session ${event.sessionId} on ${event.model}`);
        break;
      case 'tool-result':
        sawToolResult = true;
        if (event.text.includes(MARKER)) markerSeen = true;
        break;
      case 'assistant-text':
        assistantText += event.text;
        servingModel = event.model || servingModel;
        break;
      case 'turn-complete':
        log(`turn complete: ${event.subtype}`);
        resolveTurn?.();
        break;
      case 'engine-error':
        log(`ENGINE ERROR: ${event.message}`);
        if (event.fatal) resolveTurn?.();
        break;
      default:
        break;
    }
  });

  const turn = (prompt: string): Promise<void> => {
    const done = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    engine.send(prompt);
    return Promise.race([done, new Promise<void>((r) => setTimeout(r, TURN_TIMEOUT_MS))]);
  };

  console.log('live smoke test\n');
  engine.start({
    cwd: process.cwd(),
    onToolCall: ({ toolName, input, toolUseId }) => {
      inspected.push(toolName);
      const verdict = kernel.inspect({ toolName, input }, toolUseId);
      if (verdict.decision === 'deny') {
        denied.push(toolName);
        log(`guard refused ${toolName}`);
      }
      const out: {
        decision: 'deny' | 'ask' | undefined;
        reason?: string;
        updatedInput?: Record<string, unknown>;
      } = { decision: verdict.decision };
      if (verdict.reason) out.reason = verdict.reason;
      if (verdict.updatedInput) out.updatedInput = verdict.updatedInput;
      return out;
    },
    canUseTool: async (toolName, input, options) => {
      const decision = await kernel.decide({ toolName, input }, options.toolUseID);
      return decision.allow
        ? { behavior: 'allow', updatedInput: decision.input ?? input }
        : { behavior: 'deny', message: decision.reason };
    },
  });

  log('turn 1: a tool call the guards should allow');
  await turn(
    `Run the bash command: echo ${MARKER}\n` +
      'Then reply with exactly the word done and nothing else. Do not use any other tool.',
  );

  const allowedInspections = inspected.length;

  log('turn 2: a write the authorship guard must refuse');
  await turn(
    `Create a file at ./scratch-authorship-probe.md whose entire contents are this line:\n` +
      `${TRAILER}\n` +
      'Use the Write tool. If a tool is refused, stop and say refused.',
  );

  let modelSwitched = false;
  try {
    await engine.setModel('sonnet');
    modelSwitched = true;
  } catch (error) {
    log(`setModel failed: ${String(error)}`);
  }

  await engine.stop();

  console.log('\nresults\n');
  const checks: Array<[string, boolean]> = [
    ['authenticated and started a session', sessionId !== null],
    ['the shell tool ran and returned', sawToolResult],
    ['the marker came back from the shell', markerSeen],
    ['the assistant replied', assistantText.trim().length > 0],
    ['the kernel was consulted about the first tool call', allowedInspections > 0],
    ['the kernel was consulted about the write', inspected.includes('Write')],
    ['the authorship guard refused the write', denied.includes('Write')],
    ['the model could be changed mid-session', modelSwitched],
  ];
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}`);
    if (!ok) failed += 1;
  }

  console.log(`\n  tools the kernel saw : ${inspected.join(', ') || '(none)'}`);
  console.log(`  tools it refused     : ${denied.join(', ') || '(none)'}`);
  console.log(`  session id           : ${sessionId ?? '(none)'}`);
  console.log(`  serving              : ${servingModel ?? '(unknown)'}`);
  if (sessionId) {
    console.log(`\n  the Claude CLI should be able to resume it:\n    claude --resume ${sessionId}`);
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log('\nlive session works end to end, guards included.');
}

main().catch((error) => {
  console.error(`live smoke test threw: ${String(error)}`);
  process.exitCode = 1;
});
