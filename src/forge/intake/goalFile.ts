/**
 * Reads a `/goal` condition out of a goal file, for the queue's `goal` source (Aaron,
 * 2026-09-08): a brief under `C:/dev/.claude/goals/*.md` with a sibling `*.block.txt`
 * holding the literal `/goal ...` block a fresh session would paste in, or an exported
 * task under `C:/dev/boltbetz-docs/40-changes/tasks/*.md` carrying a fenced
 * ```goal-spec JSON block that this module can turn into an equivalent condition.
 *
 * Nothing here spawns a process or touches the queue -- `queue.ts#addGoalItem` calls
 * `resolveGoalBlock` once when an item is added, and carries the result on the item
 * (`goalBlock`) rather than re-resolving it every tick, since the file on disk could
 * change under a long-running item.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

/** The launch-time condition cap (`launcher.ts`'s own 4,000 characters) -- a
 *  synthesized block that would exceed it is trimmed, not silently sent over. */
export const GOAL_BLOCK_MAX_CHARS = 4000;

export type GoalBlockSource = 'block-file' | 'inline' | 'goal-spec';

export interface ResolvedGoalBlock {
  block: string;
  from: GoalBlockSource;
}

function siblingBlockPath(goalPath: string): string {
  const ext = extname(goalPath);
  const stem = goalPath.slice(0, goalPath.length - ext.length);
  return `${stem}.block.txt`;
}

/** Rule (a): a sibling `<stem>.block.txt` file, trimmed whole. */
function fromBlockFile(goalPath: string): string | undefined {
  const blockPath = siblingBlockPath(goalPath);
  if (!existsSync(blockPath)) return undefined;
  const text = readFileSync(blockPath, 'utf8').trim();
  return text.length ? text : undefined;
}

/** Rule (b): a line starting with `/goal ` inside the file itself, extended to the end
 *  of its paragraph (a blank line) or, when it opens inside a fenced block, to that
 *  fence's own closing ``` line. */
function fromInlineGoalLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.startsWith('/goal '));
  if (startIndex === -1) return undefined;

  // Whether the `/goal ` line opens inside a fenced block: an odd number of ``` fences
  // seen strictly before it.
  const fencesBefore = lines.slice(0, startIndex).filter((line) => line.trimStart().startsWith('```')).length;
  const insideFence = fencesBefore % 2 === 1;

  let endIndex = lines.length;
  if (insideFence) {
    const closing = lines.findIndex(
      (line, index) => index > startIndex && line.trimStart().startsWith('```'),
    );
    endIndex = closing === -1 ? lines.length : closing;
  } else {
    const blank = lines.findIndex((line, index) => index > startIndex && line.trim() === '');
    endIndex = blank === -1 ? lines.length : blank;
  }

  return lines.slice(startIndex, endIndex).join('\n').trim();
}

interface GoalSpec {
  acceptance_criteria?: string[];
  evidence_requirements?: string[];
  guardrails?: string[];
}

function extractGoalSpecJson(text: string): GoalSpec | undefined {
  const match = /```goal-spec\s*\n([\s\S]*?)```/.exec(text);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]!) as GoalSpec;
  } catch (error) {
    throw new Error(`goal-spec block in this file is not valid JSON: ${(error as Error).message}`);
  }
}

/** Rule (c): synthesizes a `/goal ...` condition out of a ```goal-spec block's own
 *  acceptance criteria, evidence requirements and guardrails. Drops guardrails first,
 *  then evidence, when the full text would exceed the cap; throws when even the bare
 *  criteria alone still would not fit. */
function synthesizeFromGoalSpec(goalPath: string, spec: GoalSpec): string {
  const criteria = (spec.acceptance_criteria ?? []).map((line, index) => `${index + 1}. ${line}`).join(' ');
  const head = `/goal Work ${goalPath} to completion, following its guardrails exactly. `
    + 'The goal is met only when ALL of the following appear in this conversation as the '
    + `literal output of tool calls made here: ${criteria}`;
  const tail = ' Or stop after 40 turns and report state worst-first.';

  const evidence = spec.evidence_requirements?.length
    ? ` Evidence: ${spec.evidence_requirements.join(', ')}.`
    : '';
  const guardrails = spec.guardrails?.length
    ? ` Guardrails: ${spec.guardrails.join(', ')}.`
    : '';

  const attempts = [
    `${head}${evidence}${guardrails}${tail}`,
    `${head}${evidence}${tail}`,
    `${head}${tail}`,
  ];
  const fitting = attempts.find((attempt) => attempt.length <= GOAL_BLOCK_MAX_CHARS);
  if (!fitting) {
    throw new Error(
      `synthesized /goal block for ${goalPath} exceeds ${GOAL_BLOCK_MAX_CHARS} characters even `
      + 'after dropping guardrails and evidence requirements',
    );
  }
  return fitting;
}

/** True when `path` looks like a goal file this module can resolve a condition out of:
 *  a sibling `.block.txt`, a fenced ```goal-spec block, or an inline `/goal ` line. Pure
 *  and read-only -- used by `queue.ts`'s CLI auto-detect before anything is queued. */
export function isGoalFile(path: string): boolean {
  if (existsSync(siblingBlockPath(path))) return true;
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  if (text.includes('```goal-spec')) return true;
  return /^\/goal /m.test(text);
}

/**
 * Resolves the `/goal` condition for `goalPath`, in order: a sibling `.block.txt`, an
 * inline `/goal ` line, then a fenced ```goal-spec block. Throws when the file does not
 * exist, when none of the three rules match, or when the resolved block exceeds
 * `GOAL_BLOCK_MAX_CHARS`.
 */
export function resolveGoalBlock(goalPath: string): ResolvedGoalBlock {
  if (!existsSync(goalPath) && !existsSync(siblingBlockPath(goalPath))) {
    throw new Error(`goal file not found: ${goalPath}`);
  }

  const fromFile = fromBlockFile(goalPath);
  if (fromFile !== undefined) {
    if (fromFile.length > GOAL_BLOCK_MAX_CHARS) {
      throw new Error(
        `${siblingBlockPath(goalPath)} is ${fromFile.length} characters, over the `
        + `${GOAL_BLOCK_MAX_CHARS}-character /goal condition cap`,
      );
    }
    return { block: fromFile, from: 'block-file' };
  }

  if (!existsSync(goalPath)) {
    throw new Error(`goal file not found: ${goalPath}`);
  }
  const text = readFileSync(goalPath, 'utf8');

  const inline = fromInlineGoalLine(text);
  if (inline !== undefined) {
    if (inline.length > GOAL_BLOCK_MAX_CHARS) {
      throw new Error(
        `the inline /goal line in ${goalPath} is ${inline.length} characters, over the `
        + `${GOAL_BLOCK_MAX_CHARS}-character /goal condition cap`,
      );
    }
    return { block: inline, from: 'inline' };
  }

  const spec = extractGoalSpecJson(text);
  if (spec) {
    return { block: synthesizeFromGoalSpec(goalPath, spec), from: 'goal-spec' };
  }

  throw new Error(
    `${goalPath} has no sibling .block.txt, no inline "/goal " line, and no fenced `
    + '```goal-spec block -- nothing here resolves to a /goal condition',
  );
}
