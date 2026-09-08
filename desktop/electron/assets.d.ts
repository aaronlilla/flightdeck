// esbuild bundles `.png` imports with `--loader:.png=dataurl` (see `build:main`
// in package.json), so each one resolves to a `data:image/png;base64,...` string.
declare module '*.png' {
  const dataUrl: string;
  export default dataUrl;
}
