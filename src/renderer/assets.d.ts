/** package.json version, set by build.mjs */
declare const __APP_VERSION__: string;

declare module '*.prg' {
  const data: Uint8Array;
  export default data;
}
