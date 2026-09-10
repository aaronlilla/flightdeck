/**
 * R-55: proves the Conductor agent actually offers `ask_codex`, described exactly as
 * the brief names it, and that it is wired into the session's mcpServers -- a change to
 * `buildCodexMcpServer` alone (tested via `codexAdvisor.test.ts`) cannot catch a
 * wiring gap where the tool is built but never handed to the engine.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCodexMcpServer } from '../../../src/forge/console/agent.js';
import type { CodexAdvisor } from '../../../src/forge/council/codexAdvisor.js';

const agentSource = readFileSync(join(__dirname, '../../../src/forge/console/agent.ts'), 'utf8');

describe('agent.ts: ask_codex wiring', () => {
  it('mcpServers carries both conductor and codex', () => {
    const openEngineIndex = agentSource.indexOf('private openEngine');
    expect(openEngineIndex).toBeGreaterThan(-1);
    const block = agentSource.slice(openEngineIndex, openEngineIndex + 1200);
    expect(block).toMatch(/mcpServers:\s*\{/);
    expect(block).toMatch(/conductor:\s*buildConductorMcpServer/);
    expect(block).toMatch(/codex:\s*buildCodexMcpServer/);
  });
});

describe('buildCodexMcpServer', () => {
  it('registers ask_codex, described as a second opinion that costs quota', () => {
    const fakeAdvisor = { ask: async () => ({ id: 'run-1' }) } as unknown as CodexAdvisor;
    const server = buildCodexMcpServer(fakeAdvisor, 'D:\\fake\\cwd');
    const instance = server.instance as unknown as { _registeredTools?: Record<string, { description?: string }> };
    const tools = instance._registeredTools ?? {};
    expect(Object.keys(tools)).toContain('ask_codex');
    expect(tools['ask_codex']?.description).toMatch(/second opinion/i);
    expect(tools['ask_codex']?.description).toMatch(/costs quota/i);
    expect(tools['ask_codex']?.description).toMatch(/decisions, not lookups/i);
  });
});
