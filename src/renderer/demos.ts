// Programs built into the app, listed under Open > Built-in demos.
// The PRG files live in assets/demos and are embedded by esbuild's binary loader.

import cu64d from '../../assets/demos/cu64d.prg';

export interface Demo { name: string; file: string; data: Uint8Array }

export const DEMOS: Demo[] = [
  { name: 'CU64D - 3D cube in a hi-res window', file: 'cu64d.prg', data: cu64d },
];
