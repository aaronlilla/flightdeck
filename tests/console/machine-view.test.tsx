// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MachineView } from '../../src/console/components/MachineView.js';
import type { MachineProcessRowView, MachineResponse, MachineSessionView } from '../../src/console/api.js';

function process(overrides: Partial<MachineProcessRowView> & Pick<MachineProcessRowView, 'name'>): MachineProcessRowView {
  return { ageMs: 1000, commandLine: '', output: 'not captured', children: [], ...overrides };
}

function session(overrides: Partial<MachineSessionView> = {}): MachineSessionView {
  return { repo: '/repos/flightdeck', branch: 'main', status: 'live', root: null, ...overrides };
}

function fixtureA(): MachineResponse {
  return {
    glance: '2 sessions, 4 processes, 1 unregistered, read 2 s ago, every 10 s',
    readAt: Date.now(),
    intervalMs: 10_000,
    sessions: [
      session({
        name: 'session-a',
        root: process({
          name: 'claude.exe',
          children: [process({
            name: 'node.exe',
            commandLine: 'node index.js --config=/repos/flightdeck/very/long/path/to/a/config/file/that/exceeds/eighty/characters/total.json',
            children: [],
          })],
        }),
      }),
      session({ name: 'session-b', root: process({ name: 'claude.exe', children: [] }) }),
    ],
    unregistered: [process({ name: 'codex.exe', children: [] })],
  };
}

function fixtureB(): MachineResponse {
  return {
    glance: '5 sessions, 12 processes, 3 unregistered, read 1 s ago, every 20 s',
    readAt: Date.now(),
    intervalMs: 20_000,
    sessions: [],
    unregistered: [],
  };
}

describe('MachineView', () => {
  it('renders one card per session, nested rows in order, and the unregistered label', () => {
    render(<MachineView machine={fixtureA()} />);
    const cards = screen.getAllByText(/session-a|session-b/);
    expect(cards).toHaveLength(2);
    expect(screen.getByText('not started by a session I know')).not.toBeNull();

    // Nested order: claude.exe row appears before its node.exe child in document order.
    const rows = screen.getAllByRole('row');
    const rowTexts = rows.map((r) => r.textContent ?? '');
    const claudeIdx = rowTexts.findIndex((t) => t.includes('claude.exe'));
    const nodeIdx = rowTexts.findIndex((t) => t.includes('node.exe'));
    expect(claudeIdx).toBeGreaterThanOrEqual(0);
    expect(nodeIdx).toBeGreaterThan(claudeIdx);
  });

  it('renders "output: not captured" on every process row', () => {
    render(<MachineView machine={fixtureA()} />);
    const cells = screen.getAllByText('not captured');
    // claude.exe(a), node.exe(a), claude.exe(b), codex.exe(unregistered) = 4 process rows
    expect(cells).toHaveLength(4);
  });

  it('truncates the command line by default and reveals it in full under verbose', () => {
    const { rerender } = render(<MachineView machine={fixtureA()} verbose={false} />);
    expect(screen.queryByText(/total\.json/)).toBeNull();

    rerender(<MachineView machine={fixtureA()} verbose />);
    expect(screen.getByText(/total\.json/)).not.toBeNull();
  });

  it('shows the glance sentence taken from the fixture, and changes with a different fixture', () => {
    const { rerender } = render(<MachineView machine={fixtureA()} />);
    expect(screen.getByText('2 sessions, 4 processes, 1 unregistered, read 2 s ago, every 10 s')).not.toBeNull();

    rerender(<MachineView machine={fixtureB()} />);
    expect(screen.getByText('5 sessions, 12 processes, 3 unregistered, read 1 s ago, every 20 s')).not.toBeNull();
  });
});
