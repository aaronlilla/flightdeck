#!/usr/bin/env node
/**
 * The real entry point the scheduled task registered by `scripts/login-helper-install.ps1`
 * runs at logon: wires `runLoginHelper` (`login-helper.ts`) to the console's real
 * `/events` WebSocket, the real `realSpawnLogin`, and `start ""` for opening a URL.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { realSpawnLogin } from './accounts-connect.js';
import { runLoginHelper, type LoginHelperSocket } from './login-helper.js';
import { forgeHome, serverTokenPath } from './paths.js';

const PORT = Number(process.env['FORGE_PORT'] ?? 4120);
const token = (() => {
  try {
    return readFileSync(serverTokenPath(), 'utf8').trim();
  } catch {
    return '';
  }
})();

function connect(): LoginHelperSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/events`, { headers: { 'x-forge-token': token } } as never);
  return {
    onMessage: (handler) => { socket.addEventListener('message', (event) => handler(String(event.data))); },
    onClose: (handler) => { socket.addEventListener('close', handler); },
    onError: (handler) => { socket.addEventListener('error', handler); },
    close: () => socket.close(),
  };
}

const spawnLoginFn = realSpawnLogin();

runLoginHelper({
  connect,
  spawnLogin: (provider, configDir) => spawnLoginFn(provider, configDir),
  openUrl: (url) => { spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref(); },
  postProgress: async (accountId, outcome) => {
    await fetch(`http://127.0.0.1:${PORT}/accounts/connect/helper-result`, {
      method: 'POST',
      headers: { 'x-forge-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ configDir: accountId, ...outcome }),
    });
  },
  onLog: (line) => { console.log(`[login-helper] ${line}`); },
});

console.log(`[login-helper] running against forge home ${forgeHome()}`);
