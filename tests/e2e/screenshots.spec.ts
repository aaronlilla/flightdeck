import { expect, test } from '@playwright/test';

const SIZES: { name: string; width: number; height: number }[] = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '720x900', width: 720, height: 900 },
];

for (const size of SIZES) {
  for (const theme of ['dark', 'light'] as const) {
    test(`board at ${size.name}, ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto('/');
      await expect(page.getByTestId('lane-FLT-201')).toBeVisible();
      if (theme === 'light') await page.getByText('dark').click();
      await page.screenshot({ path: `tests/e2e/__screenshots__/board-${size.name}-${theme}.png`, fullPage: false });
    });
  }
}
