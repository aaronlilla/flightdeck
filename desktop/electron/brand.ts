/**
 * Window and tray icons built from the bundled data URLs. `nativeImage` reads
 * a data URL directly, which sidesteps the Windows path in `LoadImage` that
 * cannot open a file inside app.asar.
 */
import { nativeImage, type NativeImage } from 'electron';

import { ICON_DATA_URL } from './brand-assets';

/** The 256 px tile as the window icon, so the taskbar button shows it in dev and packaged alike. */
export function appIcon(): NativeImage {
  return nativeImage.createFromDataURL(ICON_DATA_URL);
}

/** The same tile at 32 px for the notification area, which picks 16 or 32 itself. */
export function trayIcon(): NativeImage {
  return appIcon().resize({ width: 32, height: 32 });
}
