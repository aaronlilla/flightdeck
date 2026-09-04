/**
 * The master: a Fable session that decides and nothing else.
 *
 * Fable is the expensive tier, so the only way it earns a place is by staying small. It
 * reads packets other runs already wrote, it never does the wide reading itself, and it
 * has no Bash and no data-source MCP servers, because a master that can run commands
 * turns into a worker within an afternoon and takes the top tier with it.
 *
 * The context assertion is the one that will fail first as the system grows: every packet
 * added to the master's prompt is charged at the top tier on every turn. Under 30,000 is
 * the budget, and this row is what makes exceeding it visible on the day it happens
 * rather than on the bill.
 */
import { describe, expect, it } from 'vitest';

import {
  MASTER_CLASS,
  MASTER_CONTEXT_BUDGET,
  MASTER_TOOLS,
  buildMasterRequest,
  estimateTokens,
} from '../../src/forge/master.js';
import { contextFor, modelFor, modelIdFor } from '../../src/forge/policy.js';

function packets(count: number, words = 120) {
  return Array.from({ length: count }, (_unused, index) => ({
    run: `run-${index}`,
    ticket: `BBZ-${index}`,
    text: Array.from({ length: words }, (_w, w) => `finding${index}x${w}`).join(' '),
  }));
}

describe('the master runs on the master class', () => {
  it('is Fable', () => {
    expect(modelFor(MASTER_CLASS)).toBe('fable');
    expect(buildMasterRequest({ packets: packets(2) }).model).toBe(modelIdFor('fable'));
  });

  it('is budgeted well under a working session', () => {
    expect(contextFor(MASTER_CLASS)).toBeLessThanOrEqual(MASTER_CONTEXT_BUDGET);
  });
});

describe('what the master is allowed to do', () => {
  it('has exactly Read, Glob and Grep plus its own decision tool', () => {
    expect([...MASTER_TOOLS].sort()).toEqual(['Glob', 'Grep', 'Read', 'forge_decide']);
  });

  it('has no Bash', () => {
    expect(MASTER_TOOLS).not.toContain('Bash');
  });

  it('has no editing tools, because it decides rather than builds', () => {
    for (const banned of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task']) {
      expect(MASTER_TOOLS).not.toContain(banned);
    }
  });

  it('passes that list through to the request unchanged', () => {
    expect(buildMasterRequest({ packets: packets(1) }).allowedTools.sort())
      .toEqual(['Glob', 'Grep', 'Read', 'forge_decide']);
  });

  it('registers no data-source MCP servers', () => {
    const request = buildMasterRequest({ packets: packets(1) });
    expect(Object.keys(request.mcpServers)).toEqual(['forge']);
  });

  it('reads only the packets directory', () => {
    const request = buildMasterRequest({ packets: packets(1), packetsDir: 'C:/dev/.forge/packets' });
    expect(request.cwd).toBe('C:/dev/.forge/packets');
  });
});

describe('the context budget', () => {
  it('keeps a per-call prompt under 30000 tokens', () => {
    const request = buildMasterRequest({ packets: packets(8) });
    expect(estimateTokens(request.prompt)).toBeLessThan(30_000);
  });

  it('stays under the budget when handed far more packets than it can carry', () => {
    const request = buildMasterRequest({ packets: packets(400) });
    expect(estimateTokens(request.prompt)).toBeLessThan(MASTER_CONTEXT_BUDGET);
  });

  it('says how many packets it dropped rather than dropping them quietly', () => {
    const request = buildMasterRequest({ packets: packets(400) });
    expect(request.dropped).toBeGreaterThan(0);
    expect(request.prompt).toMatch(new RegExp(`${request.dropped} more`));
  });

  it('drops nothing when everything fits', () => {
    const request = buildMasterRequest({ packets: packets(3) });
    expect(request.dropped).toBe(0);
  });

  it('keeps the newest packets, since the oldest have usually been decided', () => {
    const request = buildMasterRequest({ packets: packets(400) });
    expect(request.prompt).toContain('run-399');
    expect(request.prompt).not.toContain('run-0 ');
  });
});
