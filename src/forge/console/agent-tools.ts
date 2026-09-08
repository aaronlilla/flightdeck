/**
 * The Conductor agent's tool server (2026-09-08): the console's own actions, offered to
 * one Sonnet session as in-process MCP tools the same way `buildForgeMcpServer`
 * (`adapter/engine.ts`) offers a worker its five. That function and `ForgeToolHandlers`
 * are a fixed shape every live worker depends on and are not touched here; this is a
 * sibling built with the same SDK calls.
 *
 * Every handler is a thin call into a function the buttons and the regex grammar
 * already run (`run-actions.ts`, `retire.ts`, `command.ts`, `reads.ts`, `queue-route.ts`).
 * There is no second implementation of any action behind a tool, and the six
 * irreversible tools (`kill`, `retire`, `merge_ready`, `set_daily_cap`, `set_run_cap`,
 * `queue_remove`) never act: they register a server-side confirm and answer with the
 * token, and the operator's click on the card is what runs them.
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { Message } from '../../shared/console-model.js';

/** What a tool hands back: `text` is what the model reads; `receipt` is the one-line
 *  row the operator sees the moment the tool ran; `cards` are confirm cards the reply
 *  carries after the model's own text. */
export interface ToolOutcome {
  text: string;
  receipt?: string;
  cards?: Message[];
  /** Ledger id and reversibility of the underlying action, so a receipt the agent shows
   *  carries the same Undo affordance the button/grammar path does. */
  jid?: string | null;
  undoable?: boolean;
}

export const QUEUE_SOURCES = ['ticket', 'brief', 'query', 'backlog', 'hotfix', 'goal'] as const;

export interface ConductorToolHandlers {
  list_lanes: (input: Record<string, never>) => Promise<ToolOutcome>;
  lane_detail: (input: { lane: string }) => Promise<ToolOutcome>;
  pause: (input: { lane?: string; repo?: string }) => Promise<ToolOutcome>;
  resume: (input: { lane?: string }) => Promise<ToolOutcome>;
  kill: (input: { lane: string; reason?: string; andRetire?: boolean }) => Promise<ToolOutcome>;
  retire: (input: { lane: string }) => Promise<ToolOutcome>;
  unretire: (input: { lane: string }) => Promise<ToolOutcome>;
  reopen: (input: { lane: string }) => Promise<ToolOutcome>;
  recheck: (input: { lane: string }) => Promise<ToolOutcome>;
  reaudit: (input: { lane: string }) => Promise<ToolOutcome>;
  merge_ready: (input: Record<string, never>) => Promise<ToolOutcome>;
  send_to_run: (input: { lane: string; text: string }) => Promise<ToolOutcome>;
  amend_run: (input: { lane: string; text: string }) => Promise<ToolOutcome>;
  answer_ask: (input: { askKey?: string; text: string }) => Promise<ToolOutcome>;
  set_daily_cap: (input: { tokens: number }) => Promise<ToolOutcome>;
  set_run_cap: (input: { lane: string; tokens: number }) => Promise<ToolOutcome>;
  spend_today: (input: Record<string, never>) => Promise<ToolOutcome>;
  what_stuck: (input: Record<string, never>) => Promise<ToolOutcome>;
  why_stuck: (input: { lane: string }) => Promise<ToolOutcome>;
  queue_list: (input: Record<string, never>) => Promise<ToolOutcome>;
  queue_add: (input: { source: (typeof QUEUE_SOURCES)[number]; input: string }) => Promise<ToolOutcome>;
  queue_remove: (input: { id: string }) => Promise<ToolOutcome>;
  queue_retry: (input: { id: string }) => Promise<ToolOutcome>;
}

export type ConductorToolName = keyof ConductorToolHandlers;

/** The six tools that never act on the model's own say-so. */
export const IRREVERSIBLE_TOOLS: readonly ConductorToolName[] = [
  'kill', 'retire', 'merge_ready', 'set_daily_cap', 'set_run_cap', 'queue_remove',
];

export const CONDUCTOR_SERVER_NAME = 'conductor';

function reply(outcome: ToolOutcome) {
  return { content: [{ type: 'text' as const, text: outcome.text }] };
}

const LANE = z.string().describe('A lane: its ticket key (ABC-123), its id, or a piece of its title.');

export function buildConductorMcpServer(handlers: ConductorToolHandlers): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: CONDUCTOR_SERVER_NAME,
    tools: [
      tool('list_lanes', 'Every lane on the board with its state, whether a session is live, its PR and its reason.',
        {},
        async () => reply(await handlers.list_lanes({}))),
      tool('lane_detail', 'One lane in full: what it is doing now, its story, its gate log and its recent thread.',
        { lane: LANE },
        async (args) => reply(await handlers.lane_detail(args))),
      tool('pause', 'Pause one lane, or every running lane (optionally only those on a repo). Reversible.',
        { lane: LANE.optional(), repo: z.string().optional().describe('Only lanes whose repo or goal contains this.') },
        async (args) => reply(await handlers.pause(args))),
      tool('resume', 'Resume one paused lane, or every lane waiting on the operator when no lane is given. Reversible.',
        { lane: LANE.optional() },
        async (args) => reply(await handlers.resume(args))),
      tool('kill', 'Propose stopping a lane for good. Needs the operator to click Confirm; nothing stops until they do. Set andRetire to also take the lane off the board once killed.',
        { lane: LANE, reason: z.string().optional(), andRetire: z.boolean().optional() },
        async (args) => reply(await handlers.kill(args))),
      tool('retire', 'Propose taking a finished lane off the board (it stays under Archived). Needs the operator to click Confirm.',
        { lane: LANE },
        async (args) => reply(await handlers.retire(args))),
      tool('unretire', 'Bring an archived lane back onto the board. Reversible.',
        { lane: LANE },
        async (args) => reply(await handlers.unretire(args))),
      tool('reopen', 'Retry a killed, blocked or exhausted lane from its packet.',
        { lane: LANE },
        async (args) => reply(await handlers.reopen(args))),
      tool('recheck', 'Re-read a lane\'s PR checks, audit and drift right now.',
        { lane: LANE },
        async (args) => reply(await handlers.recheck(args))),
      tool('reaudit', 'Run the council audit again on a lane\'s PR.',
        { lane: LANE },
        async (args) => reply(await handlers.reaudit(args))),
      tool('merge_ready', 'Propose merging every lane whose PR is ready. Needs the operator to click Run plan.',
        {},
        async () => reply(await handlers.merge_ready({}))),
      tool('send_to_run', 'Deliver a message to a lane with a live session. Refused when nothing is listening.',
        { lane: LANE, text: z.string() },
        async (args) => reply(await handlers.send_to_run(args))),
      tool('amend_run', 'Rewrite a running lane\'s brief with a correction, and tell the session now.',
        { lane: LANE, text: z.string() },
        async (args) => reply(await handlers.amend_run(args))),
      tool('answer_ask', 'Answer an open question a lane asked the operator.',
        { askKey: z.string().optional(), text: z.string() },
        async (args) => reply(await handlers.answer_ask(args))),
      tool('set_daily_cap', 'Propose a new daily token cap for the whole fleet. Needs Confirm.',
        { tokens: z.number().int().positive() },
        async (args) => reply(await handlers.set_daily_cap(args))),
      tool('set_run_cap', 'Propose a token cap for one lane. Needs Confirm.',
        { lane: LANE, tokens: z.number().int().positive() },
        async (args) => reply(await handlers.set_run_cap(args))),
      tool('spend_today', 'Tokens spent today.',
        {},
        async () => reply(await handlers.spend_today({}))),
      tool('what_stuck', 'Every lane the liveness check calls stuck, with why.',
        {},
        async () => reply(await handlers.what_stuck({}))),
      tool('why_stuck', 'Why one lane is stuck, with the last things it did.',
        { lane: LANE },
        async (args) => reply(await handlers.why_stuck(args))),
      tool('queue_list', 'The intake queue: every item, its state, and whether the queue is paused.',
        {},
        async () => reply(await handlers.queue_list({}))),
      tool('queue_add', 'Add work to the intake queue from a ticket key, a pasted brief, a Jira query, a backlog filter or a hotfix.',
        { source: z.enum(QUEUE_SOURCES), input: z.string() },
        async (args) => reply(await handlers.queue_add(args))),
      tool('queue_remove', 'Propose removing an item from the intake queue. Needs Confirm.',
        { id: z.string() },
        async (args) => reply(await handlers.queue_remove(args))),
      tool('queue_retry', 'Queue a parked or failed item again.',
        { id: z.string() },
        async (args) => reply(await handlers.queue_retry(args))),
    ],
  });
}

const NOOP: ToolOutcome = { text: '' };
const NOOP_HANDLERS: ConductorToolHandlers = {
  list_lanes: async () => NOOP, lane_detail: async () => NOOP, pause: async () => NOOP, resume: async () => NOOP,
  kill: async () => NOOP, retire: async () => NOOP, unretire: async () => NOOP, reopen: async () => NOOP,
  recheck: async () => NOOP, reaudit: async () => NOOP, merge_ready: async () => NOOP, send_to_run: async () => NOOP,
  amend_run: async () => NOOP, answer_ask: async () => NOOP, set_daily_cap: async () => NOOP,
  set_run_cap: async () => NOOP, spend_today: async () => NOOP, what_stuck: async () => NOOP,
  why_stuck: async () => NOOP, queue_list: async () => NOOP, queue_add: async () => NOOP,
  queue_remove: async () => NOOP, queue_retry: async () => NOOP,
};

/** Reflected off the built server, the way `FORGE_TOOL_NAMES` is, so a tool added to
 *  the server above and forgotten anywhere else fails the parametrized test rather than
 *  drifting silently. */
function registeredToolNames(): ConductorToolName[] {
  const server = buildConductorMcpServer(NOOP_HANDLERS);
  const instance = server.instance as unknown as { _registeredTools?: Record<string, unknown> };
  const tools = instance._registeredTools;
  if (!tools || typeof tools !== 'object') {
    throw new Error(
      'buildConductorMcpServer\'s instance carries no _registeredTools object; the '
      + '@modelcontextprotocol/sdk internal shape CONDUCTOR_TOOL_NAMES reflects on has changed',
    );
  }
  return Object.keys(tools) as ConductorToolName[];
}

export const CONDUCTOR_TOOL_NAMES: readonly ConductorToolName[] = registeredToolNames();

/** The SDK-visible names: `mcp__conductor__kill` and siblings. */
export const CONDUCTOR_TOOLS: readonly string[] = CONDUCTOR_TOOL_NAMES.map((name) => `mcp__${CONDUCTOR_SERVER_NAME}__${name}`);
