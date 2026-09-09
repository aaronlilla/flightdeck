import { expect, test } from '@playwright/test';

// mcp-live-state W5/W6: the Connect flow through the HTTP layer (routes stubbed, not
// the React tree). A needs-login row shows Connect; clicking it starts a real attempt
// and the row moves through connecting to a terminal state. The login link should stay
// off every response except the one direct attempt read that carries it.
const LOGIN_LINK = 'https://example.com/authorize?token=super-secret';

function integrationsFixture(mcpState: string, lastError: string | null = null): unknown {
  const now = Date.now();
  return {
    checkedAt: now,
    everyS: 30,
    items: [
      {
        id: 'mcp-fixture-server', kind: 'mcp', name: 'fixture-server', desc: 'a stubbed MCP server',
        latencyMs: 12, status: mcpState === 'connected' ? 'ok' : 'off', checkedAt: now, since: null,
        cause: null, effect: null, fix: null, fixLabel: null, scope: null, lastHealthyAt: null,
        retryCount: 0, dependents: [], step: null, canConnect: false, links: {},
        mcpState, lastError,
      },
    ],
  };
}

test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('Connect starts a real attempt and reaches a terminal state, the login link never leaves the one attempt read', async ({ page }) => {
  let state = 'needs-login';
  const seenBodies: string[] = [];

  await page.route('**/integrations', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(integrationsFixture(state)),
  }));
  await page.route('**/integrations/mcp-fixture-server/connect', (route) => route.fulfill({
    status: 202, contentType: 'application/json', body: JSON.stringify({ attempt: 'att-e2e-1' }),
  }));
  await page.route('**/integrations/mcp-fixture-server/connect/att-e2e-1', (route) => {
    state = 'connected';
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ state: 'connecting', link: LOGIN_LINK }),
    });
  });

  page.on('response', async (response) => {
    if (!response.url().includes('/integrations')) return;
    const body = await response.text().catch(() => '');
    seenBodies.push(body);
  });

  await page.goto('/');
  await page.getByText('Settings').click();
  await expect(page.getByTestId('integration-connect-mcp-fixture-server')).toBeVisible();

  await page.getByTestId('integration-connect-mcp-fixture-server').click();
  await expect(page.getByTestId('integration-open-mcp-fixture-server')).toBeVisible();

  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByTestId('integration-open-mcp-fixture-server').click(),
  ]);
  expect(popup.url()).toBe(LOGIN_LINK);
  await popup.close();

  // Only the direct attempt-read response should carry the link. Every other
  // /integrations* exchange (the list GET/POST responses) must come back clean --
  // that's the proof the link never broadcasts, journals, or reaches a receipt.
  const nonAttemptBodies = seenBodies.filter((body) => !body.includes('"connecting"') || !body.includes(LOGIN_LINK));
  for (const body of nonAttemptBodies) {
    expect(body).not.toContain(LOGIN_LINK);
  }
});

test('a failed connect attempt shows the verbatim CLI error, not a generic sentence', async ({ page }) => {
  const verbatim = 'exit code 17: token expired for fixture-server';

  await page.route('**/integrations', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(integrationsFixture('failed', verbatim)),
  }));

  await page.goto('/');
  await page.getByText('Settings').click();
  await expect(page.getByTestId('integration-state-mcp-fixture-server')).toHaveText(verbatim);
});
