import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GOAL_BLOCK_MAX_CHARS, isGoalFile, resolveGoalBlock } from '../../../src/forge/intake/goalFile.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'goalfile-'));
}

describe('resolveGoalBlock', () => {
  it('rule (a): reads a sibling .block.txt over anything in the goal file itself', () => {
    const dir = tempDir();
    const goalPath = join(dir, '2026-09-08-thing.md');
    writeFileSync(goalPath, '# not a goal line here', 'utf8');
    writeFileSync(join(dir, '2026-09-08-thing.block.txt'), '  /goal Work the thing.  \n', 'utf8');

    expect(resolveGoalBlock(goalPath)).toEqual({ block: '/goal Work the thing.', from: 'block-file' });
  });

  it('rule (b): reads an inline /goal line to the end of its paragraph', () => {
    const dir = tempDir();
    const goalPath = join(dir, 'inline.md');
    writeFileSync(
      goalPath,
      'Some preamble.\n\n/goal Work the brief to completion.\nSecond line of the block.\n\nTrailing notes.\n',
      'utf8',
    );

    const result = resolveGoalBlock(goalPath);
    expect(result.from).toBe('inline');
    expect(result.block).toBe('/goal Work the brief to completion.\nSecond line of the block.');
  });

  it('rule (b): stops an inline /goal line at its fence, not the next blank line', () => {
    const dir = tempDir();
    const goalPath = join(dir, 'fenced.md');
    writeFileSync(
      goalPath,
      '```\n/goal Work inside a fence.\n\nStill inside.\n```\n\nAfter the fence.\n',
      'utf8',
    );

    const result = resolveGoalBlock(goalPath);
    expect(result.block).toBe('/goal Work inside a fence.\n\nStill inside.');
  });

  it('rule (c): synthesizes a condition from a fenced goal-spec block', () => {
    const dir = tempDir();
    const goalPath = join(dir, 'exported-task.md');
    const spec = {
      acceptance_criteria: ['tests pass', 'lint is clean'],
      evidence_requirements: ['npx vitest run output'],
      guardrails: ['never touch main'],
    };
    writeFileSync(
      goalPath,
      `# Exported task\n\n\`\`\`goal-spec\n${JSON.stringify(spec)}\n\`\`\`\n`,
      'utf8',
    );

    const result = resolveGoalBlock(goalPath);
    expect(result.from).toBe('goal-spec');
    expect(result.block).toContain(`Work ${goalPath} to completion`);
    expect(result.block).toContain('1. tests pass');
    expect(result.block).toContain('2. lint is clean');
    expect(result.block).toContain('Evidence: npx vitest run output.');
    expect(result.block).toContain('Guardrails: never touch main.');
    expect(result.block).toContain('Or stop after 40 turns and report state worst-first.');
  });

  it('drops guardrails, then evidence, before throwing when the block is too long', () => {
    const dir = tempDir();
    const goalPath = join(dir, 'huge.md');
    const spec = {
      acceptance_criteria: ['one short criterion'],
      evidence_requirements: ['e'.repeat(50)],
      guardrails: ['g'.repeat(GOAL_BLOCK_MAX_CHARS)],
    };
    writeFileSync(goalPath, `\`\`\`goal-spec\n${JSON.stringify(spec)}\n\`\`\`\n`, 'utf8');

    const result = resolveGoalBlock(goalPath);
    expect(result.block).not.toContain('Guardrails:');
    expect(result.block).toContain('Evidence:');
    expect(result.block.length).toBeLessThanOrEqual(GOAL_BLOCK_MAX_CHARS);
  });

  it('throws when even the bare criteria exceed the cap', () => {
    const dir = tempDir();
    const goalPath = join(dir, 'toolong.md');
    const spec = { acceptance_criteria: ['x'.repeat(GOAL_BLOCK_MAX_CHARS + 100)] };
    writeFileSync(goalPath, `\`\`\`goal-spec\n${JSON.stringify(spec)}\n\`\`\`\n`, 'utf8');

    expect(() => resolveGoalBlock(goalPath)).toThrow(/exceeds/);
  });

  it('throws when the goal file does not exist', () => {
    expect(() => resolveGoalBlock('C:/does/not/exist/nope.md')).toThrow(/not found/);
  });

  it('throws when none of the three rules match', () => {
    const dir = tempDir();
    const goalPath = join(dir, 'plain.md');
    writeFileSync(goalPath, '# just a regular note, no goal anywhere in it\n', 'utf8');

    expect(() => resolveGoalBlock(goalPath)).toThrow(/nothing here resolves/);
  });

  it('throws when a resolved sibling block file exceeds the cap', () => {
    const dir = tempDir();
    const goalPath = join(dir, 'bigblock.md');
    writeFileSync(goalPath, '# irrelevant\n', 'utf8');
    writeFileSync(join(dir, 'bigblock.block.txt'), `/goal ${'a'.repeat(GOAL_BLOCK_MAX_CHARS)}`, 'utf8');

    expect(() => resolveGoalBlock(goalPath)).toThrow(/over the/);
  });
});

describe('isGoalFile', () => {
  it('is true when a sibling .block.txt exists', () => {
    const dir = tempDir();
    const goalPath = join(dir, 'a.md');
    writeFileSync(goalPath, 'plain text', 'utf8');
    writeFileSync(join(dir, 'a.block.txt'), '/goal go', 'utf8');
    expect(isGoalFile(goalPath)).toBe(true);
  });

  it('is true when the file body has a fenced goal-spec block', () => {
    const dir = tempDir();
    const goalPath = join(dir, 'b.md');
    writeFileSync(goalPath, '```goal-spec\n{}\n```\n', 'utf8');
    expect(isGoalFile(goalPath)).toBe(true);
  });

  it('is true when the file body has an inline /goal line', () => {
    const dir = tempDir();
    const goalPath = join(dir, 'c.md');
    writeFileSync(goalPath, 'notes\n/goal do the thing\n', 'utf8');
    expect(isGoalFile(goalPath)).toBe(true);
  });

  it('is false for an ordinary brief with none of the three', () => {
    const dir = tempDir();
    const goalPath = join(dir, 'd.md');
    writeFileSync(goalPath, '# just a brief\n', 'utf8');
    expect(isGoalFile(goalPath)).toBe(false);
  });

  it('is false when the file does not exist and no sibling block exists', () => {
    expect(isGoalFile('C:/does/not/exist/nope.md')).toBe(false);
  });
});
