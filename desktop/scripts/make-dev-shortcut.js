// Writes "Forge Console (dev)" shortcuts to the Desktop and the Start Menu.
// Run it with Electron rather than Node, because only Electron's shell module
// can stamp the shortcut with an AppUserModelID:
//
//   npm run dev:shortcut   (plain Node hands off to Electron by itself)
//
// The id matches app.setAppUserModelId in electron/main.ts, so the pinned
// button and the running window share one taskbar entry instead of two. The
// shortcut launches scripts/dev-hidden.vbs, which starts the dev shell with no
// console window. Windows does not let a program pin to the taskbar, so the
// last step is a right-click on the shortcut.
const { join } = require('node:path');
const { existsSync } = require('node:fs');

// Under plain Node, hand off to Electron and exit with its code.
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(require('electron'), [__filename], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

const { app, shell } = require('electron');

const root = join(__dirname, '..');
const launcher = join(root, 'scripts', 'dev-hidden.vbs');
const icon = join(root, '..', 'brand', 'flightdeck-icon.ico');
const wscript = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');

const targets = [
  join(app.getPath('desktop'), 'Forge Console (dev).lnk'),
  join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Forge Console (dev).lnk'),
];

app.whenReady().then(() => {
  let failed = false;
  for (const path of targets) {
    const ok = shell.writeShortcutLink(path, 'create', {
      target: wscript,
      args: `"${launcher}"`,
      cwd: root,
      icon,
      iconIndex: 0,
      description: 'Forge Console from this checkout, dev mode',
      appUserModelId: 'com.forge.console',
    });
    console.log(`${ok && existsSync(path) ? 'wrote' : 'FAILED'} ${path}`);
    if (!ok) failed = true;
  }
  app.exit(failed ? 1 : 0);
});
