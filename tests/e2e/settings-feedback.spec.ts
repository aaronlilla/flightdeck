import { expect, test } from '@playwright/test';

// W3. Every Settings control answers through the action catalog, so a click has to
// leave three traces: the row saying it is connecting, the row carrying the server's
// own sentence afterwards, and the same sentence in the rail as a receipt. Before this,
// Reconnect on a row with nothing behind it replied "not wired" and the row itself
// showed nothing at all.

test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

async function openSettings(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByText('Settings').click();
}

test('Check says connecting, then carries the row status the server reported', async ({ page }) => {
  // Held open so "connecting" is a state the page really passes through, not a race.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/integrations/github/check', async (route) => {
    await held;
    await route.continue();
  });

  await openSettings(page);
  await page.getByTestId('integration-check-github').click();

  await expect(page.getByTestId('integration-row-github')).toHaveAttribute('data-row-state', 'connecting');
  await expect(page.getByTestId('integration-state-github')).toContainText('connecting');

  release();
  await expect(page.getByTestId('integration-row-github')).toHaveAttribute('data-row-state', 'connected');
  await expect(page.getByTestId('integration-state-github')).toContainText('GitHub is ok');
});

test('a failed Check shows the server error on the row, not a generic one', async ({ page }) => {
  await page.route('**/integrations/github/check', (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'the probe host refused the connection' }),
  }));

  await openSettings(page);
  await page.getByTestId('integration-check-github').click();

  await expect(page.getByTestId('integration-row-github')).toHaveAttribute('data-row-state', 'failed');
  await expect(page.getByTestId('integration-state-github')).toContainText('the probe host refused the connection');
});

test('Reconnect leaves a receipt in the rail carrying the same sentence', async ({ page }) => {
  await openSettings(page);
  await page.getByTestId('integration-reconnect-aws').click();

  await expect(page.getByTestId('integration-row-aws')).toHaveAttribute('data-row-state', 'connected');
  const sentence = await page.getByTestId('integration-state-aws').innerText();
  const said = sentence.replace(/^connected · /, '').trim();
  expect(said.length).toBeGreaterThan(0);

  await page.getByText('Board').first().click();
  await expect(page.getByTestId('rail-thread')).toContainText(said);
});

test('a row with no connect action behind it offers no connect button', async ({ page }) => {
  await openSettings(page);

  // postgres-ro is degraded and has no reconnect command declared, so the row used to
  // carry a Reconnect that could only answer "not wired".
  const row = page.getByTestId('integration-row-mcp-postgres-ro');
  await expect(row).toBeVisible();
  await expect(page.getByTestId('integration-reconnect-mcp-postgres-ro')).toHaveCount(0);
  // The check is always available: re-probing a row costs nothing and changes nothing.
  await expect(page.getByTestId('integration-check-mcp-postgres-ro')).toBeVisible();
});
