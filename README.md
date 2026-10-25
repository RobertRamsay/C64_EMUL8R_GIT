# C64EMUL8R

A Commodore 64 emulator with C64 Ultimate features and a built-in debugger in the style of C64 Debugger and the VICE monitor. It runs on Electron and TypeScript.

## Running

```bash
npm install
npm start
```

`npm run package` builds a standalone Windows app in `release/C64EMUL8R-win32-x64/C64EMUL8R.exe`. On start the packaged app writes its location to `%APPDATA%\c64emul8r\install-path.txt` so other tools can find it.

### Command line
C64EMUL8R accepts VICE's x64sc options, so tools that drive VICE can use it unchanged:

```bash
C64EMUL8R.exe -reu -reusize 16384 -reuimage data.reu -sidextra 1 -sid2address 0xd420 -autostart game.d64
```

It runs as a single window. Launching it again hands the new file to the running emulator, which resets and autostarts it. That makes the edit → build → run loop quick.

### C64 Dev Machine
C64EMUL8R ships inside C64 Dev Machine next to VICE. `npm run bundle:devmachine` packages it and copies it into the Dev Machine project as Included Files (`datafiles/c64emul8r`), so every Dev Machine build carries it. The bundled copy reads its ROMs from the Dev Machine's own VICE folder. Pass a different project path with `node tools/bundle-devmachine.mjs <path>`. The Dev Machine repo stores the bundle with Git LFS because `C64EMUL8R.exe` is over GitHub's 100 MB file limit. Run the command again after an emulator change.

In C64 Dev Machine, **OPTIONS → EMULATOR** switches between VICE (the default) and C64EMUL8R for F5 / Build & Run and the RUN FILE panel. The Dev Machine uses the bundled copy unless `[emulator] c64emul8r_path` in `c64devmachine.ini` overrides it. Without a bundled copy, it falls back to the recorded install path, then to a file picker.

Exported `_run.bat` launchers always use VICE.

`npm test` runs the headless smoke tests: boot, BASIC, PRG autostart, fast-drive save/load/directory, and true-1541 load/save.

### ROMs
The Commodore ROMs are copyrighted, so they are **not** included. Don't commit them. When the app starts it looks for `basic`, `kernal`, `chargen` and `dos1541` in these places:
- the folder chosen in *Settings → ROMs*
- the app data folder `roms/`
- any VICE installation under Program Files (VICE keeps them in `C64/` and `DRIVES/`)

Palettes (`.vpl`) found next to the VICE ROMs are added to the palette list.

## Features

**Emulation**
- 6510 CPU: every bus access is timed to the cycle (dummy reads/writes, RMW double writes, all undocumented opcodes, IRQ/NMI latency).
- VIC-II: emulated cycle by cycle in PAL 6569 and NTSC 6567R8 timing. Covers badlines and BA stalls, all graphics modes, sprite DMA, priorities and collisions, the border state machine, raster IRQs and mid-line register changes.
- SID 6581/8580: cycle-clocked oscillators and ADSR, ring mod, sync, combined waveforms, and a modelled filter. Supports an optional second SID for stereo.
- Two CIA 6526 chips: timers, TOD, ICR, keyboard matrix and joysticks.
- 1541 true drive emulation: drive 6502, two VIA chips, IEC bus and GCR disk rotation. It reads and writes, so fast loaders work. A fast virtual drive using KERNAL traps is also available.
- Media: PRG/P00, D64/G64, T64, TAP (datasette), CRT cartridges (normal, Ocean, Fun Play, Super Games, Epyx FastLoad, System 3, Dinamic, Magic Desk, EasyFlash, GMod2), and SID files.
- Autostart, drag & drop, warp, snapshots, rewind (Ctrl+Z) and clipboard typing.

**C64 Ultimate features**
- REU from 128 KB to 16 MB, with DMA
- CPU turbo up to 48 MHz
- Dual SID at configurable addresses
- Ultimate Command Interface ID at `$DF1C`
- SID player
- Ultimate-style menu/file browser (Ctrl+U): drawn with the C64 character ROM, it lets you look inside D64s and run or mount files.

**Debugger** (F12)
- CPU registers and flags, both editable
- Disassembly that follows PC, with labels, breakpoint gutter, run-to-cursor and set-PC
- Step into/over/out, run one raster line or one frame, and a raster beam marker on the screen
- Breakpoints on exec, read, write or access ranges and on raster lines. They can take conditions (`A==$20 && RL>100`). The debugger can also break on IRQ or JAM.
- Memory editor with views for each bank (CPU, RAM, ROM, VIC, 1541), highlighting changed bytes and reads/writes/execution
- Live memory map heatmap, as in C64 Debugger
- CPU history of the last 4096 instructions
- VICE-compatible monitor: `m d a > f t c h r g z n ret break watch raster del bank l s ll al io sp screen cpuhistory`, and so on
- Label import from VICE `.lbl` and KickAss `.sym`
- Viewers for VIC state, sprites, and graphics (charset, screen, bitmap and sprites at any address)
- SID voice scopes with mute, CIA timers and ports, and 1541 CPU/VIA/head state with drive breakpoints

**Input**
- Joystick ports, each fed by one or more sources (two keysets, up to four gamepads), with autofire
- Key and pad button redefinition by press-to-bind, and pad buttons mapped to C64 keys
- Symbolic or positional keyboard mapping

## Layout
- `src/core`: the emulator. It has no DOM dependencies and also runs headless in Node.
- `src/renderer`: the UI (video, audio worklet, input, debugger, dialogs, Ultimate menu)
- `src/main`: the Electron main process and preload (files, ROM discovery, settings)
- `tools/headless.ts`: smoke tests

## Known limitations / next steps
- The VIC renders sprites once per line, so sprite register changes in the middle of a line are not shown.
- The SID filter is an approximation rather than a reSID-level model.
- Not implemented yet: 1541 shift register, VIA2 pulse counting, a non-1541 drive (1571/1581), paddles and mouse, and the VICE binary monitor protocol for IDE integration.
