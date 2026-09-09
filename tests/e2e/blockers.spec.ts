import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

// Drives the Blockers view's own three-step chain (billing -> checks -> question) end
// to end against the stub's `blockers-chain` fixture: the nav badge counts the open
// steps, resolving step 1 enables step 2, and a fully resolved chain collapses under
// "Resolved today".
test.afterAll(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('the nav shows a Blockers badge for the open chain', async ({ page }) => {
  await page.request.post('/__test/fixture?name=blockers-chain');
  await page.goto('/');
  const nav = page.locator('a.nav', { hasText: 'Blockers' });
  await expect(nav).toBeVisible();
  await expect(nav).toHaveText(/Blockers\s*3/);
  await expect(page.getByText('3 blockers', { exact: false })).toBeVisible();
});

test('resolving step 1 enables step 2, and the resolved chain collapses', async ({ page }) => {
  await page.request.post('/__test/fixture?name=blockers-chain');
  await page.goto('/');
  await page.locator('a.nav', { hasText: 'Blockers' }).click();

  await expect(page.getByText('GitHub Actions billing is off', { exact: false })).toBeVisible();
  await expect(page.getByText('Checks failing on PR #39', { exact: false })).toBeVisible();

  const buttons = page.getByRole('button', { name: 'Resolved, check it' });
  await expect(buttons).toHaveCount(3);
  await expect(buttons.nth(0)).toBeEnabled();
  await expect(buttons.nth(1)).toBeDisabled();
  await expect(buttons.nth(2)).toBeDisabled();

  // "Checking…" and the step's own "Resolved HH:MM" line are real
  // (`tests/console/blockers-view.test.tsx` proves both against a controlled promise)
  // but neither survives here: the action refetches the blockers slice the moment the
  // server answers, and the resolved step leaves the open chain for "Resolved today"
  // in the same tick. So this waits for where the step actually lands.
  await buttons.nth(0).click();
  const resolvedToday = page.getByTestId('blockers-resolved-today');
  await expect(resolvedToday).toBeVisible({ timeout: 10_000 });
  await expect(resolvedToday.getByText('GitHub Actions billing is off', { exact: false }))
    .toBeVisible({ timeout: 10_000 });

  // Step 2 (now the chain's own new first open step, `checks`) is enabled once
  // billing clears; a `question` step still sits behind it, disabled.
  await expect(page.getByRole('button', { name: 'Resolved, check it' }).first()).toBeEnabled({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Resolved, check it' }).first().click();
  await expect(page.getByText('Resolved today', { exact: false })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('GitHub Actions billing is off', { exact: false })).toBeVisible();
  await expect(page.getByText('Checks failing on PR #39', { exact: false })).toBeVisible();
});
