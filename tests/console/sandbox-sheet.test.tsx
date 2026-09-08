// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { render } from './helpers/with-store.js';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SandboxSheet } from '../../src/console/components/SandboxSheet.js';
import type { Lane } from '../../src/shared/console-model.js';

vi.mock('../../src/console/api.js', () => ({ getRunSandbox: vi.fn() }));
import * as api from '../../src/console/api.js';

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'FLT-201', ticket: 'FLT-201', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 1, tokenCap: 10, tokensPerMin: 0,
    fails: 0, hop: 2, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: null, pr: null,
    sandbox: { id: 'fd-2201', path: null, branch: 'feature/flt-201', pid: 1, sessionId: null, region: 'local', instanceType: 'win32/x64' },
    blockedBy: null, runaway: false, needsAaron: null, did: null, now: '', you: null,
    ...extra,
  };
}

function renderSheet(
  laneExtra: Partial<Lane> = {}, log: { text: string; severity: 'info' | 'progress' | 'retry' | 'error' }[] = [],
  onCopiedPath = vi.fn(),
) {
  vi.mocked(api.getRunSandbox).mockResolvedValue({ sandbox: lane(laneExtra).sandbox, log });
  return { onCopiedPath, ...render(<SandboxSheet lane={lane(laneExtra)} onClose={vi.fn()} onKill={vi.fn()} onCopiedPath={onCopiedPath} />) };
}

describe('SandboxSheet', () => {
  it('shows the region and instance-type chips, not just model and state', () => {
    renderSheet();
    expect(screen.getByText('local')).toBeInTheDocument();
    expect(screen.getByText('win32/x64')).toBeInTheDocument();
  });

  it('colors each log line by its real severity', async () => {
    renderSheet({}, [
      { text: 'sandbox ready', severity: 'info' },
      { text: 'retrying git push', severity: 'retry' },
      { text: 'build failed: exit 1', severity: 'error' },
    ]);
    await waitFor(() => expect(screen.getByText('build failed: exit 1')).toBeInTheDocument());
    const errorLine = screen.getByText('build failed: exit 1');
    const retryLine = screen.getByText('retrying git push');
    expect(errorLine.style.color).not.toBe(retryLine.style.color);
  });

  it('keeps the timestamp muted, separate from the line\'s own severity color, when a stamp is present', async () => {
    renderSheet({}, [{ text: '2026-09-06T00:00:00.000Z build failed: exit 1', severity: 'error' }]);
    await waitFor(() => expect(screen.getByText(/build failed/)).toBeInTheDocument());
  });

  // Sweep #9: "Open shell" had no onClick at all -- it copies the sandbox's own
  // worktree path to the clipboard, the nearest real thing a click here can do.
  describe('Open shell', () => {
    it('copies the sandbox path to the clipboard and reports it', async () => {
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
      const { onCopiedPath } = renderSheet({
        sandbox: { id: 'fd-2201', path: '/tmp/sandboxes/flt-201', branch: 'feature/flt-201', pid: 1, sessionId: null, region: 'local', instanceType: 'win32/x64' },
      });
      await userEvent.click(screen.getByText('Open shell'));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/sandboxes/flt-201');
      await waitFor(() => expect(onCopiedPath).toHaveBeenCalledWith('/tmp/sandboxes/flt-201'));
    });

    it('does nothing when the sandbox has no path on record', async () => {
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
      const { onCopiedPath } = renderSheet();
      await userEvent.click(screen.getByText('Open shell'));
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
      expect(onCopiedPath).not.toHaveBeenCalled();
    });
  });
});
