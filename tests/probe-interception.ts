/**
 * Which interception point actually sees every tool call?
 *
 * The live smoke test showed a Bash call running without the permission
 * callback being consulted, almost certainly because a permission rule in the
 * loaded settings already allowed it. If that is right, then guards hung off
 * the permission callback never see an allowed tool, and the enforcement layer
 * has a hole in exactly the place it claims to cover.
 *
 * This probe registers both interception points at once and reports which of
 * them fired, so the answer is measured rather than assumed.
 */
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const canUseToolCalls: string[] = [];
const preToolUseCalls: string[] = [];

async function main(): Promise<void> {
  const events: string[] = [];

  const response = query({
    prompt:
      'Run the bash command: echo probe-ok\nThen reply with exactly the word done and nothing else.',
    options: {
      cwd: process.cwd(),
      settingSources: ['user', 'project', 'local'],
      canUseTool: async (toolName) => {
        canUseToolCalls.push(toolName);
        return { behavior: 'allow', updatedInput: {} };
      },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                const name = (input as { tool_name?: string }).tool_name ?? 'unknown';
                preToolUseCalls.push(name);
                return { continue: true };
              },
            ],
          },
        ],
      },
    },
  });

  for await (const message of response as AsyncIterable<SDKMessage>) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') events.push(`tool_use:${block.name}`);
      }
    }
    if (message.type === 'result') {
      events.push(`result:${message.subtype}`);
      break;
    }
  }

  console.log('\nprobe results\n');
  console.log(`  tool calls the model made : ${events.filter((e) => e.startsWith('tool_use')).join(', ') || '(none)'}`);
  console.log(`  canUseTool fired for      : ${canUseToolCalls.join(', ') || '(never fired)'}`);
  console.log(`  PreToolUse hook fired for : ${preToolUseCalls.join(', ') || '(never fired)'}`);

  const toolCount = events.filter((e) => e.startsWith('tool_use')).length;
  console.log('\nconclusion\n');
  if (toolCount === 0) {
    console.log('  inconclusive: the model used no tools, so neither point was exercised.');
    return;
  }
  if (canUseToolCalls.length < toolCount) {
    console.log(
      `  canUseTool saw ${canUseToolCalls.length} of ${toolCount} tool calls. It is NOT a` +
        ' reliable interception point: an allowed tool bypasses it.',
    );
  } else {
    console.log(`  canUseTool saw all ${toolCount} tool calls.`);
  }
  if (preToolUseCalls.length >= toolCount) {
    console.log(`  PreToolUse saw all ${toolCount} tool calls, so guards belong there.`);
  } else {
    console.log(`  PreToolUse saw ${preToolUseCalls.length} of ${toolCount}.`);
  }
}

main().catch((error) => {
  console.error(`probe threw: ${String(error)}`);
  process.exitCode = 1;
});
