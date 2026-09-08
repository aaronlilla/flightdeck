/**
 * The Settings panel's own small page: a plain key/value form over `forgeEnv` (add,
 * remove, save), the same data-URL approach `status-page.ts` uses. `entries` seeds the
 * form with whatever `forgeEnv` the app already has; the row order is whatever
 * `Object.entries` gave the caller, since nothing here depends on it staying stable.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

import { LOCKUP_DATA_URL } from './brand-assets';

export function settingsPageHtml(entries: Record<string, string> = {}): string {
  const rowsJson = escapeHtml(JSON.stringify(Object.entries(entries)));
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #0b0d12; color: #e6e8ef; font: 13px/1.5 -apple-system, Segoe UI, sans-serif; }
  #wrap { padding: 16px; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
  #brand { display: block; height: 30px; margin-bottom: 14px; }
  h1 { font-size: 14px; margin: 0 0 4px; }
  #hint { color: #9aa4c0; font-size: 11.5px; margin-bottom: 12px; }
  #rows { flex: 1; overflow-y: auto; }
  .row { display: flex; gap: 8px; margin-bottom: 6px; }
  .row input { flex: 1; background: #05060a; border: 1px solid #1c2030; border-radius: 4px; color: #e6e8ef; padding: 6px 8px; font: 12px Consolas, monospace; }
  .row input.key { flex: 0 0 220px; }
  #footer { display: flex; gap: 8px; margin-top: 12px; }
  button { background: #1c2030; color: #e6e8ef; border: 1px solid #2c3150; border-radius: 4px; padding: 6px 12px; cursor: pointer; }
  button:hover { background: #262c47; }
  #status { margin-left: auto; align-self: center; font-size: 11.5px; color: #9aa4c0; }
</style>
</head>
<body>
<div id="wrap">
  <img id="brand" src="${LOCKUP_DATA_URL}" alt="Flightdeck">
  <h1>Forge environment</h1>
  <div id="hint">Merged into the console's own environment the next time it is started -- FORGE_QUEUE, FORGE_JIRA_*, FORGE_PORT, anything the operator needs without a user-level environment variable.</div>
  <div id="rows"></div>
  <div id="footer">
    <button id="add-row">Add</button>
    <button id="save">Save</button>
    <span id="status"></span>
  </div>
</div>
<script>
  const rowsEl = document.getElementById('rows');
  const statusEl = document.getElementById('status');
  const initial = JSON.parse('${rowsJson}');

  function addRow(key, value) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      '<input class="key" placeholder="KEY">' +
      '<input class="value" placeholder="value">' +
      '<button class="remove">Remove</button>';
    row.querySelector('.key').value = key ?? '';
    row.querySelector('.value').value = value ?? '';
    row.querySelector('.remove').addEventListener('click', () => row.remove());
    rowsEl.appendChild(row);
  }

  initial.forEach(([key, value]) => addRow(key, value));
  if (initial.length === 0) addRow('', '');

  document.getElementById('add-row').addEventListener('click', () => addRow('', ''));

  document.getElementById('save').addEventListener('click', () => {
    const entries = {};
    rowsEl.querySelectorAll('.row').forEach((row) => {
      const key = row.querySelector('.key').value.trim();
      if (key) entries[key] = row.querySelector('.value').value;
    });
    window.settingsBridge.save(entries);
    statusEl.textContent = 'saved';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  });
</script>
</body>
</html>`;
}
