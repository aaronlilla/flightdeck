/**
 * Build and dev-server config for the Forge console.
 *
 * Cut 1 never touches `src/forge/**`, so the console runs against the real
 * server only through a dev-time proxy, and against a fixture stub server for
 * tests and screenshots. The proxy target and the dev token both come from
 * the environment so nothing machine-specific is written into this file.
 */
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

const target = process.env['FORGE_PROXY_TARGET'] ?? 'http://127.0.0.1:4120';
const devToken = process.env['FORGE_TOKEN'] ?? '';

function proxied(ws = false): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    ws,
    configure(proxy) {
      // The built page reads its token from a `<meta>` tag the server injects.
      // Nothing injects that tag in dev, so the proxy carries it instead.
      proxy.on('proxyReq', (proxyReq) => {
        if (devToken) proxyReq.setHeader('x-forge-token', devToken);
      });
    },
  };
}

export default defineConfig({
  root: 'src/console',
  plugins: [react()],
  build: {
    outDir: '../../dist/console',
    emptyOutDir: true,
    // Both servers that serve `dist/console/` (the forge server and the stub) read
    // every file as UTF-8 text, so a hashed PNG on disk would arrive corrupted.
    // Images stay inside the bundle as data URLs instead; the brand assets are
    // the only ones so far and the largest is under 128 KB.
    assetsInlineLimit: 256 * 1024,
  },
  server: {
    // Every route the client in src/console/api.ts calls. A route missing here gets
    // Vite's index.html instead of JSON, and the board reads that as the server being
    // unreachable; tests/console/vite-proxy-routes.test.ts keeps the two lists together.
    proxy: {
      '/lanes': proxied(),
      '/thread': proxied(),
      '/journal': proxied(),
      '/integrations': proxied(),
      '/accounts': proxied(),
      '/caps': proxied(),
      '/machine': proxied(),
      '/proposals': proxied(),
      '/whatis': proxied(),
      '/command': proxied(),
      '/run': proxied(),
      '/state': proxied(),
      '/queue': proxied(),
      '/blockers': proxied(),
      '/send': proxied(),
      '/amend': proxied(),
      '/clear': proxied(),
      '/merge-ready': proxied(),
      '/retire-finished': proxied(),
      '/sync': proxied(),
      '/watcher': proxied(),
      '/events': proxied(true),
    },
  },
});
