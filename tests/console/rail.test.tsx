// @vitest-environment jsdom
/**
 * W4 (2026-09-08): the operator can see the Conductor working. The App here talks to a
 * real `ForgeServer` whose model is the scripted fake from `agent-fake.ts`, gated so the
 * test can look at the rail between one tool receipt and the next. Nothing in the
 * server or the client is stubbed.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../src/console/App.js';
import { Inbox } from '../../src/forge/inbox.js';
import { Journal } from '../../src/forge/journal.js';
import { Registry } from '../../src/forge/registry.js';
import { Lanes } from '../../src/forge/supervisor.js';
import { ForgeServer } from '../../src/forge/server.js';
import { policyPath } from '../../src/forge/policy.js';
import { hangingQuery, scriptedQuery, type ScriptedTurn } from '../forge/console/agent-fake.js';
import type { QueryFn } from '../../src/adapter/engine.js';

class FakeSocket {
  static instances: FakeSocket[] = [];

  onopen: (() => void) | null = null;

  onclose: (() => void) | null = null;

  onmessage: ((event: { data: string }) => void) | null = null;

  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  close(): void { this.onclose?.(); }

  send(): void {}
}

const DEAD = '2026-09-04-acme-c2-rn';

let dir: string;
let server: ForgeServer;
let originalFetch: typeof fetch;

async function start(queryFn: QueryFn, modelPolicyPath?: string): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'forge-rail-'));
  process.env['FORGE_HOME'] = dir;
  const journal = new Journal(join(dir, 'fleet.jsonl'));
  journal.append({ event: 'run.started', run: DEAD, actor: 'runner' });
  journal.append({ event: 'run.finished', run: DEAD, verdict: 'unverified' });
  journal.close();
  new Lanes(join(dir, 'lanes')).put(DEAD, { column: 'c', model: 'claude-sonnet-5', context: 1000, cost_usd: 0, session_id: 's1' });
  server = new ForgeServer({
    lanes: new Lanes(join(dir, 'lanes')), inbox: new Inbox(join(dir, 'inbox')), journalPath: join(dir, 'fleet.jsonl'),
    registry: new Registry(join(dir, 'registry')), port: 0, conductorQueryFn: queryFn, token: 'rail-token',
    ...(modelPolicyPath ? { modelPolicyPath } : {}),
  });
  const base = `http://127.0.0.1:${await server.listen()}`;
  originalFetch = global.fetch;
  global.fetch = ((input: RequestInfo | URL, init?: RequestInit) => originalFetch(`${base}${String(input)}`, init)) as typeof fetch;
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'forge-token');
  meta.setAttribute('content', 'rail-token');
  document.head.appendChild(meta);
}

beforeEach(() => {
  FakeSocket.instances = [];
});

afterEach(async () => {
  global.fetch = originalFetch;
  document.querySelectorAll('meta[name="forge-token"]').forEach((node) => node.remove());
  await server.close();
});

/** Nudges the App the way a live-feed frame does: it refetches `/thread`. */
async function feedFrame(): Promise<void> {
  await act(async () => {
    FakeSocket.instances[0]!.onmessage?.({ data: JSON.stringify({ event: 'conductor.receipt' }) });
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
}

async function typeIntoRail(text: string): Promise<void> {
  await userEvent.type(screen.getByPlaceholderText(/command…/), `${text}{Enter}`);
}

async function mount(): Promise<HTMLElement> {
  render(<App eventStreamOptions={{ WebSocketImpl: FakeSocket as unknown as typeof WebSocket }} />);
  await waitFor(() => expect(screen.getByTestId('rail-thread')).toBeInTheDocument());
  await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
  return screen.getByTestId('rail-thread');
}

describe('W4: the rail shows the Conductor working', () => {
  it('after send the working row is present; on reply it is gone and the reply is present, labelled as the agent', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const script: ScriptedTurn[] = [{ gate: async () => { await held; }, reply: 'Nothing is waiting on you.' }];
    await start(scriptedQuery(script).fn);
    const rail = await mount();

    await typeIntoRail('status');
    expect(within(rail).getByTestId('conductor-working').textContent).toBe('Conductor is working…');

    release();
    await waitFor(() => expect(rail.textContent).toMatch(/Nothing is waiting on you\./));
    expect(within(rail).queryByTestId('conductor-working')).not.toBeInTheDocument();
    expect(within(rail).getAllByTestId('reply-label').map((node) => node.textContent)).toContain('Conductor');
  });

  it('on timeout the working row turns into the fallback text, and the grammar answers labelled as the grammar', async () => {
    const policy = JSON.parse(readFileSync(policyPath(), 'utf8')) as Record<string, unknown>;
    (policy['classes'] as Record<string, Record<string, unknown>>)['implement']!['timeoutMs'] = 200;
    const override = join(mkdtempSync(join(tmpdir(), 'forge-rail-policy-')), 'policy.json');
    writeFileSync(override, JSON.stringify(policy), 'utf8');
    await start(hangingQuery().fn, override);
    const rail = await mount();
    // The App learns the timeout from `/state` on the same refresh that paints the
    // board, so a painted lane tile means the timeout has landed.
    await waitFor(() => expect(screen.getByTestId(`lane-${DEAD}`)).toBeInTheDocument());

    await typeIntoRail('status');
    await waitFor(() => {
      expect(rail.textContent).toMatch(/the Conductor did not answer in 0s; the grammar answered instead…/);
    });
    await waitFor(() => expect(rail.textContent).toMatch(/The Conductor could not answer \(the Conductor did not answer in 0s\)\. The grammar answered instead:/), { timeout: 3000 });
    expect(within(rail).queryByTestId('conductor-working')).not.toBeInTheDocument();
    expect(within(rail).getAllByTestId('reply-label').map((node) => node.textContent)).toContain('Conductor (grammar)');
    expect(rail.textContent).toMatch(/1 lane: 1 unverified\./);
  });

  it('two tool calls before the reply appear as two receipt rows, in order, each before the reply row', async () => {
    const gates: Array<() => void> = [];
    const waits = [0, 1, 2].map(() => new Promise<void>((resolve) => { gates.push(resolve); }));
    const script: ScriptedTurn[] = [{
      gate: async (step) => { await waits[step]!; },
      tools: [
        { tool: 'retire', input: { lane: DEAD } },
        { tool: 'send_to_run', input: { lane: DEAD, text: 'stop' } },
      ],
      reply: 'Proposed removing it, and could not message it because nothing is listening.',
    }];
    await start(scriptedQuery(script).fn);
    const rail = await mount();

    await typeIntoRail(`remove ${DEAD} and tell it to stop`);
    expect(within(rail).getByTestId('conductor-working')).toBeInTheDocument();

    gates[0]!();
    await feedFrame();
    await waitFor(() => expect(rail.textContent).toMatch(/remove proposed for .*, waiting on Confirm/));
    expect(rail.textContent).not.toMatch(/refused: /);
    expect(rail.textContent).not.toMatch(/Proposed removing it/);
    expect(within(rail).getByTestId('conductor-working')).toBeInTheDocument();

    gates[1]!();
    await feedFrame();
    await waitFor(() => expect(rail.textContent).toMatch(/refused: .* has no live session/));
    expect(rail.textContent).not.toMatch(/Proposed removing it/);

    gates[2]!();
    await waitFor(() => expect(rail.textContent).toMatch(/Proposed removing it/));
    const text = rail.textContent ?? '';
    const first = text.indexOf('remove proposed for');
    const second = text.indexOf('refused: ');
    const reply = text.indexOf('Proposed removing it');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(reply).toBeGreaterThan(second);
    expect(within(rail).queryByTestId('conductor-working')).not.toBeInTheDocument();
    expect(within(rail).getByText('Confirm — irreversible')).toBeInTheDocument();
  });
});
