/**
 * The falsifier for the login helper: it must be event-driven, never a poll. "No event,
 * no spawn" is the detector -- an implementation that polls `claude auth status` on a
 * timer to notice a pending login would pass every other assertion here.
 */
import { describe, expect, it, vi } from 'vitest';

import { runLoginHelper, type LoginHelperSocket } from '../../src/forge/login-helper.js';

function fakeSocket() {
  const handlers: { message?: (data: string) => void; close?: () => void; error?: (e: unknown) => void } = {};
  const socket: LoginHelperSocket = {
    onMessage: (h) => { handlers.message = h; },
    onClose: (h) => { handlers.close = h; },
    onError: (h) => { handlers.error = h; },
    close: () => {},
  };
  return {
    socket,
    emit: (data: string) => handlers.message?.(data),
    drop: () => handlers.close?.(),
  };
}

describe('runLoginHelper', () => {
  it('one connect-requested event -> one login spawn under the right config dir, one URL open, progress posted', async () => {
    const fake = fakeSocket();
    const spawnLogin = vi.fn().mockResolvedValue({ ok: true, link: 'https://example.test/login' });
    const openUrl = vi.fn();
    const postProgress = vi.fn().mockResolvedValue(undefined);

    runLoginHelper({
      connect: () => fake.socket, spawnLogin, openUrl, postProgress,
    });
    await Promise.resolve();

    fake.emit(JSON.stringify({ event: 'accounts.connect-requested', accountId: 'acct-1', configDir: 'D:\\fake\\config\\claude-acct-1' }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnLogin).toHaveBeenCalledTimes(1);
    expect(spawnLogin).toHaveBeenCalledWith('claude', 'D:\\fake\\config\\claude-acct-1');
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('https://example.test/login');
    expect(postProgress).toHaveBeenCalledTimes(1);
    expect(postProgress).toHaveBeenCalledWith('acct-1', { ok: true, link: 'https://example.test/login' });
  });

  it('a stream drop reconnects exactly once', async () => {
    const first = fakeSocket();
    const second = fakeSocket();
    const sockets = [first.socket, second.socket];
    const connect = vi.fn(() => sockets.shift()!);
    const wait = vi.fn().mockResolvedValue(undefined);

    runLoginHelper({
      connect, spawnLogin: vi.fn(), openUrl: vi.fn(), postProgress: vi.fn(), wait,
    });
    await Promise.resolve();
    expect(connect).toHaveBeenCalledTimes(1);

    first.drop();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(wait).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('no event means no spawn, ever -- proves this is event-driven, not a poll', async () => {
    const fake = fakeSocket();
    const spawnLogin = vi.fn();
    runLoginHelper({ connect: () => fake.socket, spawnLogin, openUrl: vi.fn(), postProgress: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnLogin).not.toHaveBeenCalled();
  });

  it('ignores frames that are not a connect-requested event', async () => {
    const fake = fakeSocket();
    const spawnLogin = vi.fn();
    runLoginHelper({ connect: () => fake.socket, spawnLogin, openUrl: vi.fn(), postProgress: vi.fn() });
    await Promise.resolve();
    fake.emit(JSON.stringify({ event: 'heartbeat', at: Date.now() }));
    fake.emit('not even json');
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnLogin).not.toHaveBeenCalled();
  });

  it('posts a failure outcome, never a URL open, when the login fails', async () => {
    const fake = fakeSocket();
    const spawnLogin = vi.fn().mockResolvedValue({ ok: false, error: 'account already linked' });
    const openUrl = vi.fn();
    const postProgress = vi.fn().mockResolvedValue(undefined);
    runLoginHelper({ connect: () => fake.socket, spawnLogin, openUrl, postProgress });
    await Promise.resolve();
    fake.emit(JSON.stringify({ event: 'accounts.connect-requested', accountId: 'acct-2', configDir: 'D:\\fake\\config\\claude-acct-2' }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(openUrl).not.toHaveBeenCalled();
    expect(postProgress).toHaveBeenCalledWith('acct-2', { ok: false, error: 'account already linked' });
  });

  it('stop() ends the loop: a drop after stop never reconnects', async () => {
    const fake = fakeSocket();
    const connect = vi.fn(() => fake.socket);
    const wait = vi.fn().mockResolvedValue(undefined);
    const helper = runLoginHelper({ connect, spawnLogin: vi.fn(), openUrl: vi.fn(), postProgress: vi.fn(), wait });
    await Promise.resolve();
    helper.stop();
    fake.drop();
    await Promise.resolve();
    await Promise.resolve();
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
