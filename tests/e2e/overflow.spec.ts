import { expect, test } from '@playwright/test';

// Final fidelity sweep #4: the prototype never grows a horizontal scrollbar on
// the document. The top bar wraps, the needs-you strip wraps, the lane grid
// re-flows its auto-fill columns, and the rail's own clamp() shrinks before
// anything is pushed off the right edge. `scrollWidth` (the page's actual
// laid-out width) must never exceed `innerWidth` (the viewport it has to fit),
// at every width the console runs at.
const WIDTHS = [1440, 900, 720];

for (const width of WIDTHS) {
  for (const theme of ['dark', 'light'] as const) {
    test(`the document never overflows its own viewport at ${width}px, ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await expect(page.getByTestId('lane-FLT-201')).toBeVisible();
      if (theme === 'light') await page.getByText('day mode').click();
      // tests/e2e falls under the root tsconfig, which carries no dom lib (see
      // fd7d3da), so `document` and `window` don't typecheck as identifiers in an
      // evaluate() callback. A string body sidesteps that: Playwright still runs it
      // in the page, TypeScript never parses it for DOM globals.
      const { scrollWidth, innerWidth } = await page.evaluate<{ scrollWidth: number; innerWidth: number }>(
        '({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })',
      );
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    });
  }
}
