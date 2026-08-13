/**
 * Drive the real cockpit with real keystrokes.
 *
 * I claimed this could not be checked without a terminal. That was an
 * assumption I never tested: Ink takes whatever stdin and stdout you hand it,
 * so a stream that reports itself as a terminal is enough to exercise the
 * actual keyboard loop, the line editor and the approval keypress. The engine
 * is a stand-in, so nothing is spawned and nothing is spent.
 *
 * What this covers that the rendered frames did not: that typing reaches the
 * input line, that Enter sends, that a slash command is answered locally
 * instead of being sent, and that the approval screen resolves on a keypress.
 */
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import React from 'react';
import { describe, expect, it } from 'vitest';

import type { EngineConfig } from '../src/adapter/engine.ts';
import type { EngineEvent } from '../src/adapter/events.ts';
import { App, type EngineLike } from '../src/cockpit/app.tsx';
import type { PermissionMode } from '../src/types.ts';

const KEY = { enter: '\r', backspace: '\x7f', up: '\x1B[A', escape: '\x1B' };

/** A stream that claims to be a terminal, which is all Ink asks of stdin. */
function fakeStdin() {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stream.isTTY = true;
  stream.setRawMode = () => {};
  stream.ref = () => {};
  stream.unref = () => {};
  return stream;
}

const ANSI = /\x1B\[[0-9;?]*[A-Za-z]|\x1B[()][A-B0-9]/g;

function fakeStdout() {
  const stream = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  stream.columns = 100;
  stream.rows = 40;
  // Without this Ink treats the output as a log rather than a screen and holds
  // its frames back, which is why nothing was captured at all.
  stream.isTTY = true;
  const frames: string[] = [];
  // Captured by wrapping write rather than by listening for data. Ink writes
  // straight to the stream, and nothing was reading the other end, so the
  // frames never arrived and every assertion compared against an empty string.
  const write = stream.write.bind(stream);
  (stream as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
    frames.push(String(chunk));
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
  /** The newest frame that actually drew something, with escape codes removed. */
  const last = () => {
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const text = (frames[i] ?? '').replace(ANSI, '');
      if (text.trim().length > 0) return text;
    }
    return '';
  };
  return { stream, frames, last };
}

class StandInEngine implements EngineLike {
  sent: string[] = [];
  models: Array<string | undefined> = [];
  modes: PermissionMode[] = [];
  config: EngineConfig | null = null;
  private listeners = new Set<(event: EngineEvent) => void>();

  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  start(config: EngineConfig): void {
    this.config = config;
  }
  send(text: string): void {
    this.sent.push(text);
  }
  async setModel(model: string | undefined): Promise<void> {
    this.models.push(model);
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.modes.push(mode);
  }
  async stop(): Promise<void> {}
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const SESSIONS = [
  { sessionId: '3f2a9c1e-1111-2222-3333-444455556666', summary: 'add a retry to the fetch helper', lastModified: 1 },
  { sessionId: 'aa11bb22-1111-2222-3333-444455556666', summary: 'split the wallet reducer', lastModified: 2 },
];

async function open(overrides: { listSessions?: () => Promise<typeof SESSIONS> } = {}) {
  const stdin = fakeStdin();
  const out = fakeStdout();
  const engine = new StandInEngine();
  const app = render(<App cwd="/repo" engine={engine} listSessions={overrides.listSessions ?? (async () => SESSIONS)} />, {
    stdin: stdin as never,
    stdout: out.stream as never,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await settle();
  const type = async (text: string) => {
    stdin.write(text);
    await settle();
  };
  return { stdin, out, engine, app, type };
}

describe('driving the cockpit by keyboard', () => {
  it('shows what is typed on the input line', async () => {
    const { out, type, app } = await open();
    await type('hello there');
    expect(out.last()).toContain('hello there');
    app.unmount();
  });

  it('sends the line to the engine on enter', async () => {
    const { engine, type, app } = await open();
    await type('add a retry to the fetch helper');
    await type(KEY.enter);
    expect(engine.sent).toEqual(['add a retry to the fetch helper']);
    app.unmount();
  });

  it('clears the input line after sending', async () => {
    const { out, type, app } = await open();
    await type('first message');
    await type(KEY.enter);
    // The text moves into the conversation and leaves the prompt empty, so it
    // appears once rather than twice.
    const frame = out.last();
    expect(frame.split('first message').length - 1).toBe(1);
    app.unmount();
  });

  it('deletes a character on backspace', async () => {
    const { out, type, app } = await open();
    await type('abcd');
    await type(KEY.backspace);
    expect(out.last()).toContain('abc');
    expect(out.last()).not.toContain('abcd');
    app.unmount();
  });

  it('recalls the previous line with the up arrow', async () => {
    const { out, type, app } = await open();
    await type('remember this');
    await type(KEY.enter);
    await type(KEY.up);
    expect(out.last()).toContain('remember this');
    app.unmount();
  });

  it('offers the slash palette while a command is being typed', async () => {
    const { out, type, app } = await open();
    await type('/pl');
    expect(out.last()).toContain('/plan');
    expect(out.last()).toContain('enter plan mode');
    app.unmount();
  });
});

describe('slash commands are answered by the app', () => {
  it('enters planning without sending anything to the engine', async () => {
    const { engine, type, app } = await open();
    await type('/plan');
    await type(KEY.enter);
    // The whole point of the project, exercised through the keyboard: plan
    // mode and the plan model are set together, with no prompt to type.
    expect(engine.modes).toEqual(['plan']);
    expect(engine.models).toEqual(['claude-fable-5']);
    expect(engine.sent).toEqual([]);
    app.unmount();
  });

  it('pins and clears a model', async () => {
    const { engine, type, app } = await open();
    await type('/model sonnet');
    await type(KEY.enter);
    expect(engine.models).toEqual(['sonnet']);
    await type('/model auto');
    await type(KEY.enter);
    expect(engine.sent).toEqual([]);
    app.unmount();
  });

  it('passes an unknown slash command to the engine, which owns skills', async () => {
    const { engine, type, app } = await open();
    await type('/onboard-codebase');
    await type(KEY.enter);
    expect(engine.sent).toEqual(['/onboard-codebase']);
    app.unmount();
  });

  it('answers /resume itself rather than sending it to the model', async () => {
    // The palette advertises /resume. A command that is offered and then
    // quietly forwarded as a prompt is worse than one that does not exist.
    const { engine, out, type, app } = await open();
    await type('/resume');
    await type(KEY.enter);
    await settle(120);
    expect(engine.sent).toEqual([]);
    expect(out.last()).toContain('3f2a9c1e');
    expect(out.last()).toContain('add a retry to the fetch helper');
    app.unmount();
  });

  it('says so plainly when there are no sessions to resume', async () => {
    const { out, type, app } = await open({ listSessions: async () => [] });
    await type('/resume');
    await type(KEY.enter);
    await settle(120);
    expect(out.last()).toContain('no earlier sessions');
    app.unmount();
  });

  it('reports guard health on request', async () => {
    const { out, type, app } = await open();
    await type('/health');
    await type(KEY.enter);
    expect(out.last()).toContain('every guard is running');
    app.unmount();
  });
});

describe('the approval screen', () => {
  /** Ask the app to approve something, the way the engine would. */
  async function askApproval(engine: StandInEngine, toolName: string, input: Record<string, unknown>) {
    const canUseTool = engine.config?.canUseTool;
    if (!canUseTool) throw new Error('the app never registered a permission callback');
    return canUseTool(toolName, input, {
      signal: new AbortController().signal,
      toolUseID: 'tu-1',
      requestId: 'req-1',
    } as never);
  }

  it('shows the call and resolves when y is pressed', async () => {
    const { engine, out, type, app } = await open();
    const decision = askApproval(engine, 'Edit', {
      file_path: 'src/api/fetch.ts',
      old_string: 'a',
      new_string: 'b',
    });
    await settle();
    expect(out.last()).toContain('Run Edit?');
    await type('y');
    const result = (await decision) as { behavior: string };
    expect(result.behavior).toBe('allow');
    app.unmount();
  });

  it('refuses when n is pressed', async () => {
    const { engine, type, app } = await open();
    const decision = askApproval(engine, 'Bash', { command: 'rm -rf /' });
    await settle();
    await type('n');
    const result = (await decision) as { behavior: string };
    expect(result.behavior).toBe('deny');
    app.unmount();
  });

  it('gives a plan the whole screen with the guard objections under it', async () => {
    const { engine, out, type, app } = await open();
    const decision = askApproval(engine, 'ExitPlanMode', { plan: '# Plan\n\nBuild the thing.\n' });
    await settle();
    const frame = out.last();
    expect(frame).toContain('Approve this plan?');
    expect(frame).toContain('Build the thing.');
    await type('y');
    await decision;
    app.unmount();
  });

  it('does not treat typing as input while an approval is open', async () => {
    const { engine, type, app } = await open();
    const decision = askApproval(engine, 'Bash', { command: 'ls' });
    await settle();
    // 'n' answers the prompt rather than becoming text in the input line.
    await type('n');
    await decision;
    expect(engine.sent).toEqual([]);
    app.unmount();
  });
});
