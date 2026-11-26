# C64EMUL8R — Agent Guide

Cycle-accurate **Commodore 64 / C64 Ultimate** emulator with built-in debugger (6510, VIC-II PAL/NTSC, SID 6581/8580 + dual SID, dual CIA 6526, true 1541 + virtual drive, REU, turbo, VICE CLI & binary monitor). Written in **TypeScript**, packaged with **Electron** and an in-progress **Tauri** (Rust/WebView2/WKWebView) host.

## Layout
- `src/core/` — Pure TypeScript emulator core (zero DOM dependencies; runs headless in Node).
- `src/renderer/` — UI, video, audio worklet, input, F12 debugger, beam scrub, Ultimate menu, `tauriHost.ts`.
- `src/main/` — Electron main process & preload (CLI flags, ROM discovery, settings, single-instance handoff).
- `src-tauri/` — Tauri Rust host (`src-tauri/src/main.rs` mirrors Electron main process).
- `build.mjs` — esbuild bundler for app and tests.
- `tools/` — Headless smoke test (`headless.ts`), benchmarks (`bench.ts`, `framebench.ts`), binary monitor verifier (`binmon_client.py`), macOS/Tauri packagers, and C64 Dev Machine bundlers.
- `tools/c64-mcp/` — Claude MCP bridge (`bridge.mjs`, stdio) the app links to over ws://127.0.0.1:5175 (Settings > Claude MCP link); app-side commands in `src/renderer/mcp.ts`, pure helpers in `src/core/inspect.ts`. See its README.

## Commands
- Dev / build: `npm start` (`node build.mjs && electron .`) | `npm run build` | `npm run watch`
- Typecheck: `npm run typecheck` (`tsc --noEmit -p .`)
- Headless tests: `npm test` (boot, BASIC, PRG autostart, mid-line sprite regs, binary monitor, fast & true 1541)
- Binary monitor e2e (against running instance): `python tools/binmon_client.py`
- Package Electron: `npm run package` (Windows → `release/`) | `npm run package:mac` (signed/notarized universal DMG on Mac)
- Package Tauri: `npm run tauri:build` (Windows, uses `tools/tauri.mjs` + `rust-lld`) | `npm run package:mac-tauri`
- Bundle into C64 Dev Machine: `npm run bundle:devmachine` / `bundle:devmachine-tauri` (Win) or `bundle:devmachine-mac` / `-mac-tauri` (Mac).

## Rules & Safety
- **Never commit copyrighted Commodore ROMs** (`basic`, `kernal`, `chargen`, `dos1541`).
- Keep `src/core/` completely free of DOM/Electron/Tauri APIs so headless Node tests and both desktop hosts share it unchanged.
- Mirror any host-API changes between `src/main/` (Electron) and `src-tauri/src/main.rs` + `src/renderer/tauriHost.ts` (Tauri).
- Skip `release/`, `dist/`, `node_modules/`, `src-tauri/target/`.
