import { expect, test } from '@playwright/test';

// The lockup travels inside the JS bundle as a data URL because both servers
// read static files as text and would corrupt a PNG on disk. `naturalWidth`
// is the check that the bytes decoded, which a 200 with a mangled body would
// not give; a src that is not a data URL means an asset slipped out to disk.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/fixture?name=default');
});

test('the top bar shows the Flightdeck lockup, decoded, in both themes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('lane-FLT-201')).toBeVisible();
  const lockup = page.getByTestId('brand-lockup');
  await expect(lockup).toBeVisible();
  await expect(lockup).toHaveAttribute('alt', 'Flightdeck');
  await expect(lockup).toHaveAttribute('src', /^data:image\/png;base64,/);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decoded = await lockup.evaluate((el: any) => ({
    complete: el.complete as boolean, width: el.naturalWidth as number, height: el.naturalHeight as number,
  })) as { complete: boolean; width: number; height: number };
  expect(decoded.complete).toBe(true);
  expect(decoded.width).toBeGreaterThan(0);
  expect(decoded.height).toBeGreaterThan(0);
  const box = await lockup.boundingBox();
  expect(box?.height).toBe(28);

  await page.getByText('day mode').click();
  await expect(page.locator('.app')).toHaveClass(/thL/);
  await expect(lockup).toBeVisible();
});

test('the page carries the tile as its favicon, as a data URL', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('lane-FLT-201')).toBeVisible();
  const href = await page.locator('link[rel="icon"]').getAttribute('href');
  expect(href).toMatch(/^data:image\/png;base64,/);
  // Written as a string: the root typecheck runs these specs without the DOM lib.
  const decoded = await page.evaluate(`new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = ${JSON.stringify(href ?? '')};
  })`) as { w: number; h: number };
  expect(decoded).toEqual({ w: 64, h: 64 });
});
