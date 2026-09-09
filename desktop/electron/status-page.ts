/**
 * The small HTML page shown in the status window while the console comes
 * up. Built as a string and loaded through `loadURL('data:...')`, the same
 * way the reference app's port-conflict page works, so it needs no file on
 * disk and no server of its own.
 */
import { LOCKUP_DATA_URL } from './brand-assets';

export function statusPageHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #0b0d12; color: #e6e8ef; font: 13px/1.5 -apple-system, Segoe UI, sans-serif; }
  #wrap { padding: 16px; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
  #brand { display: block; height: 30px; width: auto; align-self: flex-start; margin-bottom: 14px; }
  #message { font-size: 14px; margin-bottom: 10px; }
  #log { flex: 1; overflow-y: auto; background: #05060a; border: 1px solid #1c2030; border-radius: 6px; padding: 8px; white-space: pre-wrap; font: 12px/1.4 Consolas, monospace; color: #9aa4c0; }
  #picker { display: none; margin-top: 10px; }
  #retry { display: none; margin-top: 10px; }
  button { background: #1c2030; color: #e6e8ef; border: 1px solid #2c3150; border-radius: 4px; padding: 6px 12px; cursor: pointer; }
  button:hover { background: #262c47; }
  #queue-banner { display: none; margin-bottom: 10px; padding: 6px 10px; border-radius: 4px; background: #3a2d10; color: #f0c674; font-size: 12px; }
</style>
</head>
<body>
<div id="wrap">
  <img id="brand" src="${LOCKUP_DATA_URL}" alt="Flightdeck">
  <div id="queue-banner">Queue is off — set FORGE_QUEUE=1 in Settings to hand it work from the board.</div>
  <div id="message">Starting Forge…</div>
  <div id="log"></div>
  <div id="picker"><button id="pick-folder">Choose the Forge checkout…</button></div>
  <div id="retry"><button id="retry-console">Retry</button></div>
</div>
<script>
  const messageEl = document.getElementById('message');
  const logEl = document.getElementById('log');
  const pickerEl = document.getElementById('picker');
  const retryEl = document.getElementById('retry');
  const queueBannerEl = document.getElementById('queue-banner');
  window.statusBridge.onStatus((text) => { messageEl.textContent = text; });
  window.statusBridge.onLog((line) => {
    logEl.textContent += line + '\\n';
    logEl.scrollTop = logEl.scrollHeight;
  });
  window.statusBridge.onNeedFolder(() => { pickerEl.style.display = 'block'; });
  // Shown whenever a bring-up attempt fails to answer -- the first launch
  // and a watchdog-triggered revive both land here through the same status
  // window, and Retry just asks for another attempt.
  window.statusBridge.onReviveFailed(() => { retryEl.style.display = 'block'; });
  // C.3: persistent, unlike the status/log lines above -- it stays up for the whole
  // time this window is open, not just until the next status message overwrites it.
  window.statusBridge.onQueueState((queueOn) => {
    queueBannerEl.style.display = queueOn ? 'none' : 'block';
  });
  document.getElementById('pick-folder').addEventListener('click', () => {
    window.statusBridge.pickFolder();
  });
  document.getElementById('retry-console').addEventListener('click', () => {
    retryEl.style.display = 'none';
    window.statusBridge.retryConsole();
  });
</script>
</body>
</html>`;
}
