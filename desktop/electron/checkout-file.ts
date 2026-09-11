/**
 * Item 4, plan step 9, 2026-09-10: one canonical checkout every launcher reads.
 * `~/.forge/console.checkout` is a plain text file holding the absolute path,
 * written once by Step 0 and kept current by whichever process re-points the
 * canonical checkout in the future -- scraping `console.launch.cmd` for its own
 * `cd /d` line was rejected as fragile (plan, "Non-goals"/rival accounts); this
 * file is the single source every reader (`locateCheckout`, `dev.cjs`,
 * `dev-hidden.vbs`, the launcher script itself) agrees on instead.
 */
export interface CheckoutFileFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
}

export function readCheckoutFile(
  fs: CheckoutFileFs,
  join: (...parts: string[]) => string,
  homeDir: string,
): string | undefined {
  const path = join(homeDir, '.forge', 'console.checkout');
  if (!fs.existsSync(path)) return undefined;
  try {
    const content = fs.readFileSync(path, 'utf8').trim();
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}
