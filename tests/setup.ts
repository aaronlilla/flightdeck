/**
 * Test setup.
 *
 * Ink checks whether it is running in CI and, when it thinks it is, stops
 * drawing frames as it goes so it does not fill a build log with redraws. That
 * is sensible for a program printing output and wrong for a test that reads the
 * screen: every screen assertion compared against an empty string on the build
 * machine while passing locally.
 *
 * Clearing the detection here makes the tests exercise the interactive render
 * path, which is the only path that ever runs on a real machine. It changes how
 * Ink draws and nothing about what is asserted.
 *
 * This runs before each test file, and therefore before Ink is imported, which
 * matters because the detection is evaluated once when its module loads.
 */
for (const name of [
  'CI',
  'GITHUB_ACTIONS',
  'BUILD_NUMBER',
  'RUN_ID',
  'CONTINUOUS_INTEGRATION',
]) {
  delete process.env[name];
}
