/**
 * The options a real worker session is opened with.
 *
 * No model is called here. What is asserted is the mapping, which is where a runner goes
 * wrong silently: a worker started with the wrong config directory writes into the
 * interactive session's store, one started with an inherited environment saves no
 * transcript, and neither of those looks like a failure from outside. The specimens below
 * pin every option that has cost a session today.
 *
 * The one thing this cannot prove is that the subprocess authenticates on the
 * subscription. That needs a live run and is named in the report as not verified.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { buildWorkerOptions, contextOf, toEngineConfig } from '../../src/forge/sdkengine.js';
import { buildOptions } from '../../src/adapter/engine.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-sdk-'));
  process.env['FORGE_HOME'] = home;
});

const REQUEST = {
  model: 'claude-sonnet-5',
  prompt: '# Goal\n\nDo the thing.\n',
  cwd: join(tmpdir(), 'forge-workspace-specimen'),
  maxTurns: 120,
  env: { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
};

describe('the options a worker runs under', () => {
  it('opens on the model the class chose', () => {
    expect(buildWorkerOptions(REQUEST).model).toBe('claude-sonnet-5');
  });

  it('carries the turn cap from the class rather than trusting the prompt', () => {
    expect(buildWorkerOptions(REQUEST).maxTurns).toBe(120);
  });

  it('runs in the directory it was given', () => {
    expect(buildWorkerOptions(REQUEST).cwd).toBe(join(tmpdir(), 'forge-workspace-specimen'));
  });

  it('bypasses permission prompts, because nobody is at the terminal', () => {
    expect(buildWorkerOptions(REQUEST).permissionMode).toBe('bypassPermissions');
  });

  it('reads user and project settings, so CLAUDE.md and the skills travel', () => {
    expect(buildWorkerOptions(REQUEST).settingSources).toEqual(['user', 'project']);
  });

  it('does not read local settings, which are one machine\'s and not the fleet\'s', () => {
    expect(buildWorkerOptions(REQUEST).settingSources).not.toContain('local');
  });

  it('passes the cleaned environment through', () => {
    const options = buildWorkerOptions(REQUEST);
    expect(options.env?.['PATH']).toBe('/usr/bin');
    expect(options.env?.['CLAUDECODE']).toBeUndefined();
  });

  it('pins CLAUDE_CONFIG_DIR to the fleet directory rather than inheriting one', () => {
    // No fleet login on this machine, injected: proves the pin, not the fleet-vs-forge
    // choice, which has its own specimens below.
    const options = buildWorkerOptions({
      ...REQUEST, env: { CLAUDE_CONFIG_DIR: '/somebody/elses/claude', PATH: '/usr/bin' },
    }, () => false);
    expect(options.env['CLAUDE_CONFIG_DIR']).toContain(home);
    expect(options.env['CLAUDE_CONFIG_DIR']).not.toBe('/somebody/elses/claude');
  });

  it('unsets ANTHROPIC_API_KEY so the subscription login is what authenticates', () => {
    const options = buildWorkerOptions({ ...REQUEST, env: { ANTHROPIC_API_KEY: 'sk-nope' } });
    expect(options.env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('registers the forge tool server and nothing else', () => {
    expect(Object.keys(buildWorkerOptions(REQUEST).mcpServers ?? {})).toEqual(['forge']);
  });

  it('B.3.9: offers the five tools a worker needs to talk back, matching buildForgeMcpServer', () => {
    const forge = buildWorkerOptions(REQUEST).mcpServers?.['forge'];
    expect(forge?.tools.sort())
      .toEqual(['forge_ask', 'forge_done', 'forge_gotcha', 'forge_handoff', 'forge_report'].sort());
  });

  it('resumes rather than starting fresh when given a session', () => {
    expect(buildWorkerOptions({ ...REQUEST, resume: 'sess-1' }).resume).toBe('sess-1');
  });

  it('does not set resume when there is nothing to resume', () => {
    expect(buildWorkerOptions(REQUEST).resume).toBeUndefined();
  });
});

describe('reading how much context a turn carried', () => {
  it('adds fresh input, cache read and cache creation', () => {
    expect(contextOf({
      input_tokens: 4, cache_read_input_tokens: 190_000,
      cache_creation_input_tokens: 20_000, output_tokens: 500,
    })).toBe(210_004);
  });

  it('does not read input_tokens alone, which is single digits on a huge turn', () => {
    // The mistake that let a session reach 543,000 tokens without anything noticing.
    expect(contextOf({ input_tokens: 4, cache_read_input_tokens: 500_000 }))
      .toBeGreaterThan(400_000);
  });

  it('is zero for a turn that reported no usage', () => {
    expect(contextOf(undefined)).toBe(0);
    expect(contextOf({})).toBe(0);
  });

  it('ignores output tokens, which are not re-read next turn', () => {
    expect(contextOf({ input_tokens: 10, output_tokens: 9_000 })).toBe(10);
  });
});


describe('what actually reaches the SDK', () => {
  /**
   * The mapping above is only worth asserting if it survives the adapter. Until
   * 2026-09-04 engine.ts passed through neither env, maxTurns, mcpServers nor
   * allowedTools, so a worker could be built correctly and still open with none of them.
   */
  it('carries the environment all the way through buildOptions', () => {
    const options = buildOptions(toEngineConfig(buildWorkerOptions(REQUEST)));
    expect(options.env?.['PATH']).toBe('/usr/bin');
    expect(options.env?.['CLAUDECODE']).toBeUndefined();
  });

  it('carries the turn cap through', () => {
    expect(buildOptions(toEngineConfig(buildWorkerOptions(REQUEST))).maxTurns).toBe(120);
  });

  it('carries the forge tool server through', () => {
    const options = buildOptions(toEngineConfig(buildWorkerOptions(REQUEST)));
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['forge']);
  });

  it('carries bypassPermissions through, because nobody is at the terminal', () => {
    expect(buildOptions(toEngineConfig(buildWorkerOptions(REQUEST))).permissionMode)
      .toBe('bypassPermissions');
  });

  it('carries the pinned config directory through', () => {
    const options = buildOptions(toEngineConfig(buildWorkerOptions({
      ...REQUEST, env: { CLAUDE_CONFIG_DIR: '/somebody/elses/claude' },
    }, () => false)));
    expect(options.env?.['CLAUDE_CONFIG_DIR']).toContain(home);
  });
});
