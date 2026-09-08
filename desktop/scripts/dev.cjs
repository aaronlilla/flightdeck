// One command for shell work: bundle main.ts and status-preload.ts, keep
// watching them, and run Electron on the result, restarting it after every
// rebuild. The copy gets its own userData dir under desktop/.dev-userdata so
// it can sit beside the installed app; like any launch it attaches to the
// console already on 4120 rather than starting one.
//
// FORGE_CONSOLE_ORIGIN=http://127.0.0.1:5173 points the window at a running
// `npm run console:dev`, which hot reloads console edits inside this window.
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const esbuild = require('esbuild');
const electron = require('electron');

const root = join(__dirname, '..');
let child = null;
let pendingRestart = false;

function start() {
  child = spawn(electron, ['.'], {
    cwd: root,
    stdio: 'inherit',
    // The fresh userData remembers no checkout, so this repo is the default one.
    env: { FORGE_USER_DATA_DIR: join(root, '.dev-userdata'), FORGE_REPO_DIR: join(root, '..'), ...process.env },
  });
  console.log(`[dev] electron started, pid ${child.pid}`);
  child.on('exit', (code) => {
    child = null;
    if (pendingRestart) {
      pendingRestart = false;
      start();
      return;
    }
    console.log(`[dev] electron exited with ${code}; the next change starts it again`);
  });
}

function restart() {
  if (child) {
    pendingRestart = true;
    child.kill();
  } else {
    start();
  }
}

const restartOnRebuild = {
  name: 'restart-electron',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        console.log('[dev] bundle failed; electron left as it was');
        return;
      }
      restart();
    });
  },
};

async function main() {
  const context = await esbuild.context({
    entryPoints: [join(root, 'electron', 'main.ts'), join(root, 'electron', 'status-preload.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    loader: { '.png': 'dataurl' },
    outdir: join(root, 'build'),
    outExtension: { '.js': '.cjs' },
    logLevel: 'info',
    plugins: [restartOnRebuild],
  });
  await context.watch();
  const stop = () => {
    pendingRestart = false;
    if (child) child.kill();
    void context.dispose().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
