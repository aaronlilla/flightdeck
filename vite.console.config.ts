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
    proxy: {
      '/lanes': proxied(),
      '/thread': proxied(),
      '/journal': proxied(),
      '/integrations': proxied(),
      '/caps': proxied(),
      '/proposals': proxied(),
      '/command': proxied(),
      '/run': proxied(),
      '/events': proxied(true),
    },
  },
});
