/**
 * The master: one Fable session whose whole job is to decide.
 *
 * Fable is the top tier, and the only way it earns a place in a system built to stop
 * overspending is by staying small. So it reads packets other runs already wrote, never
 * doing the wide reading itself, and it has three read tools and one decision tool. No
 * Bash: a master that can run commands becomes a worker inside an afternoon and takes the
 * top tier with it. No data-source MCP servers: every one of them is another way for a
 * cheap question to arrive as forty thousand tokens of JSON.
 *
 * The budget is enforced here rather than hoped for. Packets are added newest first until
 * the prompt would cross it, and what did not fit is counted in the prompt itself, because
 * a master that silently sees half the fleet is worse than one that says it is behind.
 */
import { contextFor, modelFor, modelIdFor } from './policy.js';

export const MASTER_CLASS = 'master';

/**
 * The ceiling for one master call, in tokens.
 *
 * Chosen to be checkable rather than generous. Every packet in the prompt is charged at
 * the top tier on every turn, so this number is the difference between a master that
 * costs a rounding error and one that costs a lane.
 */
export const MASTER_CONTEXT_BUDGET = 30_000;

/**
 * Everything the master may do.
 *
 * `forge_decide` is its only way to act: it returns a decision to the supervisor, which
 * does the acting. That asymmetry is deliberate, and it is what keeps this session from
 * growing into the thing it supervises.
 */
export const MASTER_TOOLS = ['Read', 'Glob', 'Grep', 'forge_decide'] as const;

export interface Packet {
  run: string;
  ticket?: string;
  text: string;
}

export interface MasterRequest {
  model: string;
  className: string;
  allowedTools: string[];
  /** Only Forge's own tool server. No Jira, no Sentry, no filesystem bridge. */
  mcpServers: Record<string, { tools: string[] }>;
  cwd: string;
  prompt: string;
  /** Packets that did not fit the budget. Counted in the prompt, never hidden. */
  dropped: number;
  maxTurns: number;
}

/**
 * Roughly how many tokens a string costs.
 *
 * Four characters per token is the usual English approximation. It is an estimate and is
 * named one: the point is a budget that fails loudly at the right order of magnitude,
 * not a number accurate enough to bill from.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? '').length / 4);
}

const HEADER = [
  'You are the Forge master. You decide, and the supervisor acts.',
  '',
  'Below are packets from runs across the fleet: what each found, where, and how sure it',
  'is. You have Read, Glob and Grep over the packets directory and nothing else. You',
  'cannot run commands and you have no access to Jira, Sentry or the repositories.',
  '',
  'Return your decision through forge_decide. If a packet does not give you enough to',
  'decide on, say what is missing instead of guessing; the run that wrote it can be asked.',
  '',
].join('\n');

export interface MasterOptions {
  packets: Packet[];
  packetsDir?: string;
  budget?: number;
}

/**
 * Build one master call.
 *
 * Newest packets first. The oldest are usually the ones already decided, so if something
 * has to be left out it should be those; and whatever is left out is stated, so a thin
 * decision can be recognised as a thin decision.
 */
export function buildMasterRequest(options: MasterOptions): MasterRequest {
  const budget = options.budget ?? MASTER_CONTEXT_BUDGET;
  const newestFirst = [...options.packets].reverse();

  const chosen: string[] = [];
  let used = estimateTokens(HEADER);
  let dropped = 0;

  for (const packet of newestFirst) {
    const rendered = `--- ${packet.run}${packet.ticket ? ` (${packet.ticket})` : ''} ---\n${packet.text}\n`;
    const cost = estimateTokens(rendered);
    // Leave room for the line that reports what was dropped, or the budget is broken by
    // the sentence explaining that it was not.
    if (used + cost > budget - 200) {
      dropped += 1;
      continue;
    }
    chosen.push(rendered);
    used += cost;
  }

  const tail = dropped > 0
    ? `\n(${dropped} more packets did not fit this call's context budget and are not below. `
      + 'Decide only on what you can see, and say so.)\n'
    : '';

  return {
    model: modelIdFor(modelFor(MASTER_CLASS)),
    className: MASTER_CLASS,
    allowedTools: [...MASTER_TOOLS],
    mcpServers: { forge: { tools: ['forge_decide'] } },
    cwd: options.packetsDir ?? 'C:/dev/.forge/packets',
    prompt: HEADER + chosen.join('\n') + tail,
    dropped,
    maxTurns: Math.max(1, Math.floor(contextFor(MASTER_CLASS) / 1000)),
  };
}
