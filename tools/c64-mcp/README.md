# C64EMUL8R MCP bridge

Lets Claude Code (or any MCP client) look at and tweak a program running in
C64EMUL8R: "make the border black", "turn sprite 2 light blue", "give voice 1
a pulse sound", "redraw the player sprite", "make the blue darker". Node 22+
built-ins only, no `npm install`.

```
Claude --stdio--> bridge.mjs (hub, 127.0.0.1:5175) <--WebSocket-- C64EMUL8R (Settings > Claude MCP link)
```

- The first bridge owns the port; bridges of other Claude sessions relay through
  it and take over when it goes away.
- **Pairing:** the bridge makes a random key in `~/.c64emul8r-mcp/token`; the app
  reads the same file, so there is nothing to copy. Never paste it anywhere.
  Web pages can't connect (origin check + key).
- **Off by default:** tick **Settings > Claude MCP link** (remembered). The app
  connects within 3 s, says so in a toast, and shows a toast for every change.
- Works in the Electron and the Tauri builds: the page opens the WebSocket itself.

## Set up

```
claude mcp add --scope user c64-emul8r -- "C:\Program Files\nodejs\node.exe" "D:\POLYTRICITY\C64EMUL8R\C64_EMUL8R_GIT\tools\c64-mcp\bridge.mjs"
```

(`node bridge.mjs --claude-config` prints the JSON.) `C64_MCP_PORT` and
`C64_MCP_TOKEN_FILE` override the port and key file for the bridge (the app
always uses 5175 and `~/.c64emul8r-mcp/token`).

## Keeping the program intact

The tools are graded by how much they touch:

1. **Nothing in RAM** (the default for looks and sound):
   - `c64_set_override`: the emulator forces bits of a VIC / SID register every
     time the program writes it (border, backgrounds, sprite colours, SID
     waveform / ADSR / pulse width / filter / volume, or any register with a bit
     mask). The SID gate bit stays the program's, so the tune keeps playing.
   - `c64_set_palette`: RGB of the 16 colours. `c64_mute_voice`.
2. **Data bytes in RAM**, undoable: `c64_set_sprite` (63 bytes of sprite data),
   `c64_patch_immediate` (only the operand of `LDA/LDX/LDY #nn`: same
   instruction, same length, so the code flow can't change).
3. **Any RAM**: `c64_write_memory` refuses executed code, zero page, the stack,
   vectors and `$D000-$DFFF` unless `force=true`; the server instructions tell
   Claude to warn the user and ask before forcing.

While linked, the core records which addresses the CPU executes (`codeMap`), so
writes over code are caught, operand bytes included. Code that hasn't run since
the link started (a later level) is not known yet: the warnings say so.
Every change has an id; `c64_undo` reverts the last one (or one and everything
after it), and **camera menu > Undo all Claude changes** reverts them all.

## Tools

| Tool | What it does |
|---|---|
| `c64_status` | link state, running / paused, PC, frame, overrides |
| `c64_screenshot` | PNG of the screen (waits for a fresh frame) |
| `c64_vic_state`, `c64_sid_state` | decoded VIC (mode, layout, colours, every sprite drawn last frame) and SID (voices, ADSR, filter) |
| `c64_list_fields` | names `c64_set_override` takes |
| `c64_read_memory` | hex or disassembly, marks executed code |
| `c64_get_sprite`, `c64_set_sprite` | sprite as 21 text rows (`.#` or `.123` multicolour) |
| `c64_set_override`, `c64_clear_overrides` | force register bits |
| `c64_set_palette`, `c64_mute_voice` | colours' RGB, voice on / off |
| `c64_find_writers` | which instructions write an address, with values and the `LDA #nn` feeding them |
| `c64_patch_immediate`, `c64_write_memory` | RAM patches (guarded) |
| `c64_undo`, `c64_changes`, `c64_run` | history, pause / resume |

## Test

With C64EMUL8R running and linked:

```
node tools/c64-mcp/call.mjs c64_status
node tools/c64-mcp/call.mjs c64_set_override "{\"field\":\"border\",\"value\":\"black\"}"
node tools/c64-mcp/call.mjs c64_screenshot --out shot.png
node tools/c64-mcp/call.mjs --script steps.json --out shots/   # [["tool", {args}], ...]
```

`npm test` covers the core side (overrides, field names, sprite rows, code detection).

## Adding to it

A command is a `cmd_<name>` method in `src/renderer/mcp.ts` plus an entry in
`TOOLS` in `bridge.mjs` (`ro: true` if it changes nothing). Pure helpers go in
`src/core/inspect.ts`.
