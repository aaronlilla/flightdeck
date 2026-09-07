import { expect, test } from '@playwright/test';

// Cut-line #2: a stale token. The real server checks `x-forge-token` on every
// read and write except `/state` (server.ts's own `authorized()`), 401ing
// with `{ error: 'missing or wrong X-Forge-Token' }` -- matched in the stub
// so this scenario has something real to 401 against, rather than the stub's
// prior blanket acceptance of any token.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('a wrong x-forge-token 401s a read', async ({ request }) => {
  const response = await request.get('/lanes', { headers: { 'x-forge-token': 'a-stale-token' } });
  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: 'missing or wrong X-Forge-Token' });
});

test('a wrong x-forge-token 401s a write', async ({ request }) => {
  const response = await request.post('/run/FLT-201/pause', { headers: { 'x-forge-token': 'a-stale-token' } });
  expect(response.status()).toBe(401);
});

// The console reads its token from the page's own <meta name="forge-token">
// tag, filled in server-side on the HTML response -- there is no route to make
// the already-loaded page hold a stale one short of a page-level fetch
// override, which is what this proves: every request the app itself makes
// carries a token the stub no longer recognizes, and the app has to read that
// the same way it reads any other unreachable server (no separate "your
// session expired" surface exists yet).
test('a token gone stale mid-session surfaces as the disconnected banner, same as any other unreachable server', async ({ page }) => {
  // The root tsconfig carries no DOM lib (see fd7d3da), so `window` and
  // `Headers` don't typecheck as identifiers in a typed callback here --
  // a string body sidesteps that the same way overflow.spec.ts's evaluate() does.
  await page.addInitScript(`(() => {
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const headers = new Headers((init && init.headers) || {});
      headers.set('x-forge-token', 'a-stale-token');
      return realFetch(input, Object.assign({}, init, { headers }));
    };
  })()`);
  await page.goto('/');
  await expect(page.getByText(/live feed lost/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Composer disabled/)).toBeVisible();
});
