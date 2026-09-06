import { defineConfig, devices } from '@playwright/test';

const PORT = 4130;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run console:build && npm run console:stub',
    url: `http://127.0.0.1:${PORT}/lanes`,
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { FORGE_STUB_PORT: String(PORT), FORGE_STUB_TOKEN: 'stub-token' },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
