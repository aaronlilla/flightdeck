// Stamps the Flightdeck icon and the product name into the packaged exe.
// electron-builder's own step for this (`signAndEditExecutable`) needs its
// winCodeSign download, whose archive holds macOS symlinks that 7-Zip cannot
// create on Windows without the symlink privilege, so that step stays off and
// this hook does the one part of it the build needs.
const { join } = require('node:path');
const rcedit = require('rcedit');

const ICON = join(__dirname, '..', '..', 'brand', 'flightdeck-icon.ico');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { appInfo } = context.packager;
  const exe = join(context.appOutDir, `${appInfo.productFilename}.exe`);
  await rcedit(exe, {
    icon: ICON,
    'file-version': appInfo.version,
    'product-version': appInfo.version,
    'version-string': {
      ProductName: appInfo.productName,
      FileDescription: appInfo.productName,
    },
  });
};
