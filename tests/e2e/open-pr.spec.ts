import { expect, test } from '@playwright/test';

/**
 * Opening a pull request, pressed in a browser.
 *
 * The refusals are what this is here for. Each one is a different thing to do next --
 * push the branch, look at the one that already exists -- and a control that collapsed
 * them into "could not open it" would send a person to GitHub to find out which.
 */
test('the sheet opens a pull request, asking first and saying a build is spent', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  const sheet = page.getByTestId('ticket-sheet');
  await expect(sheet).toBeVisible();

  const panel = sheet.getByTestId('lane-open-pr');
  await expect(panel).toBeVisible();
  await panel.click();

  await sheet.getByTestId('lane-open-pr-title').fill('BBZ-201 clear the tab bar');
  await sheet.getByTestId('lane-open-pr-body').fill('What breaks\n\nThe bottom of the screen sits under the bar.');

  const [asked] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith('/open-pr') && r.method() === 'POST'),
    sheet.getByTestId('lane-open-pr-submit').click(),
  ]);
  expect(asked.postDataJSON()).toMatchObject({ title: 'BBZ-201 clear the tab bar', draft: true });

  // It asks first, and the sentence names the cost.
  await expect(sheet.getByTestId('lane-open-pr-blast')).toContainText('spends a build');
  await expect(sheet.getByTestId('lane-open-pr-result')).toHaveCount(0);

  await sheet.getByTestId('lane-open-pr-submit').click();
  await expect(sheet.getByTestId('lane-open-pr-result')).toContainText('opened #42');
});

test('editing the title after the first press cannot open the old one', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  const sheet = page.getByTestId('ticket-sheet');
  await sheet.getByTestId('lane-open-pr').click();
  await sheet.getByTestId('lane-open-pr-title').fill('BBZ-201 wrng ttile');
  await sheet.getByTestId('lane-open-pr-body').fill('What breaks\n\nIt does.');
  await sheet.getByTestId('lane-open-pr-submit').click();
  await expect(sheet.getByTestId('lane-open-pr-blast')).toBeVisible();

  await sheet.getByTestId('lane-open-pr-title').fill('BBZ-201 right title');
  await expect(sheet.getByTestId('lane-open-pr-blast')).toHaveCount(0);

  const [asked] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith('/open-pr') && r.method() === 'POST'),
    sheet.getByTestId('lane-open-pr-submit').click(),
  ]);
  expect(asked.postDataJSON()).toMatchObject({ title: 'BBZ-201 right title' });
});

test('it will not open one with no title or no body', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('lane-FLT-201').click();
  const sheet = page.getByTestId('ticket-sheet');
  await sheet.getByTestId('lane-open-pr').click();

  await expect(sheet.getByTestId('lane-open-pr-submit')).toBeDisabled();
  await sheet.getByTestId('lane-open-pr-title').fill('BBZ-201 a title');
  await expect(sheet.getByTestId('lane-open-pr-submit')).toBeDisabled();
  await sheet.getByTestId('lane-open-pr-body').fill('What breaks\n\nIt does.');
  await expect(sheet.getByTestId('lane-open-pr-submit')).toBeEnabled();
});
