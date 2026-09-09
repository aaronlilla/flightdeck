import { expect, test } from '@playwright/test';

// The Accounts view against the stub's `seedAccounts` fixture: one card per registered
// account, the paused account marked as such with its reset, a not-connected account
// carrying the probe's error, the Codex row folded from its ledger, and a Connect panel
// whose commands are built from the server's own home directory.
test('the nav opens the Accounts view and every registered account has a card', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByTestId('nav-accounts');
  await expect(nav).toBeVisible();
  // fleet-b is paused and fleet-c is not connected: two on the badge.
  await expect(nav).toHaveText(/Accounts\s*2/);
  await nav.click();
  await expect(page.getByTestId('accounts-view')).toBeVisible();
  for (const id of ['fleet', 'fleet-b', 'fleet-c', 'codex']) {
    await expect(page.getByTestId(`account-${id}`)).toBeVisible();
  }
  await expect(page.getByText('3 Claude accounts and 1 Codex')).toBeVisible();
});

test('windows, pause, connection and the Codex ledger read as the fixture says', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('nav-accounts').click();

  const fleet = page.getByTestId('account-fleet');
  await expect(fleet.getByTestId('window-five-hour')).toContainText('82%');
  await expect(fleet.getByTestId('window-seven-day')).toContainText('37%');
  await expect(fleet).toContainText('launches go here');
  await expect(fleet).toContainText('3 live runs of 4');
  await expect(fleet).toContainText('9.4M tokens today');

  const b = page.getByTestId('account-fleet-b');
  await expect(b.getByTestId('account-paused')).toBeVisible();
  await expect(b).toContainText('The five hour window is full. Nothing new starts here until');
  await expect(b.getByTestId('window-five-hour')).toContainText('100%');

  const c = page.getByTestId('account-fleet-c');
  await expect(c).toContainText('not connected');
  await expect(c).toContainText('not logged in');
  await expect(c.getByTestId('window-five-hour')).toContainText('not measured yet');

  const codex = page.getByTestId('account-codex');
  await expect(codex).toContainText('7 calls today, 41 min in total');
  await expect(codex).toContainText('Codex has no usage API');
});

test('the Connect panel prints the login and add commands for the next config dir', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('nav-accounts').click();
  const panel = page.getByTestId('connect-panel');
  await expect(panel).toBeVisible();
  // fleet-b and fleet-c exist in the fixture, so the next free name is fleet-d.
  await expect(panel.getByTestId('connect-login-command')).toHaveText('CLAUDE_CONFIG_DIR=/srv/operator/.claude-fleet-d claude\n/login');
  await expect(panel.getByTestId('connect-add-command')).toHaveText('npm run forge -- accounts add fleet-d /srv/operator/.claude-fleet-d');
  await panel.getByRole('textbox', { name: 'new account id' }).fill('night');
  await expect(panel.getByTestId('connect-add-command')).toHaveText('npm run forge -- accounts add night /srv/operator/.claude-night');
});
