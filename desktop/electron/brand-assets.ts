/**
 * The Flightdeck mark and lockup as data URLs. esbuild inlines the PNGs with
 * `--loader:.png=dataurl`, so the packaged app carries them inside app.asar and
 * needs no icon file on disk at runtime. No `electron` import here: the status
 * and settings pages build their HTML from these strings under plain Node in
 * tests.
 */
import iconPng from '../../brand/flightdeck-icon.png';
import lockupPng from '../../brand/flightdeck-lockup-h96.png';

/** The 256 px tile. */
export const ICON_DATA_URL: string = iconPng;

/** The mark plus the word, 96 px tall, for page headers. */
export const LOCKUP_DATA_URL: string = lockupPng;
