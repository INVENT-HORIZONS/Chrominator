# CLAUDE.md

Guidance for working on Chrominator.

## What this is

A Chrome/Edge extension plus Arduino firmware for hardware debugging. The extension opens in the
browser's **side panel** (so it stays open while the user browses), connects to the board over
USB serial, and exposes the board's GPIO, PWM and ADC. The serial link is only transport: the
user picks the port and never sees the link's baud rate or protocol details. (The UART terminal is
for the *board's* Serial1, not the link.)

Target board: **Arduino Nano R4** (Renesas RA4M1, board ID 4, core `arduino:renesas_uno`, macro
`ARDUINO_NANO_R4`; the core *also* defines `ARDUINO_UNOR4_MINIMA` for it, so the Nano R4 block in
`board_config.h` must come before the Minima block), ported on the `nano-r4` branch. The **Uno R3** (ATmega328P) is still supported.
`board_config.h` also has an untested Uno R4 Minima/WiFi block.

Nano R4 facts that matter here: 22 pins (D0–D13 = 0–13, A0–A7 = 14–21; LED_BUILTIN is pin 22 and
the RGB LED 23–25, not exposed yet), PWM on D3/5/6/9/10/11, 14-bit ADC, 5 V I/O, 12-bit DAC on A0
(not exposed yet), native USB (`Serial`), so D0/D1 (`Serial1`) are free and opening the port does
not reset the board. Capture on the Nano R4 is `CAPTURE_POLL`: `loop()` runs each due tick on
`micros()` with `analogRead()`, 100 samples/s (`CAPTURE_PERIOD_US` 10000), full 14-bit samples,
8 per block (`CAP_BITS`/`CAP_BLOCK_SAMPLES` overridden in `board_config.h`), 16-block queue.

Follow-on to the htmlSerialPort project (`INVENT-HORIZONS/htmlSerialPort`), which established the
Web Serial patterns and the side-panel port-picker workaround used here.

## Layout

| Path | Purpose |
|---|---|
| `docs/PROTOCOL.md` | **The protocol spec. The source of truth** for frames, commands, statuses, timings. |
| `firmware/Chrominator/Chrominator.ino` | Firmware: frame parser, command handlers, link watchdog/failsafe. |
| `firmware/Chrominator/capture.h` | Capture engine: tick, ADC scan, bit packing (10- or 14-bit), block queue. Back ends: AVR (Timer0 compare + ADC interrupt), polled (`loop()` + `micros()` + `analogRead()`, Nano R4) and simulator. |
| `firmware/Chrominator/board_config.h` | Per-board pin tables and capability flags; the only file a board port should need. |
| `extension/manifest.json` | MV3, `sidePanel` permission, Chrome 116+. Bump `version` on changes. |
| `extension/background.js` | Only sets `openPanelOnActionClick`. |
| `extension/sidepanel.html` / `.css` | Panel markup and styles. |
| `extension/js/protocol.js` | Constants, CRC-8, `encodeFrame`, `FrameParser`, reply decoders. No browser APIs. |
| `extension/js/link.js` | `ChrominatorLink`: request/reply by SEQ, timeouts, retries, heartbeat, LOST detection, resync. No DOM. |
| `extension/js/serial.js` | Web Serial transport (`SerialTransport`) and port selection (`choosePort`, `lastUsedPort`). |
| `extension/js/scope.js` | `Scope` (the Capture panel): per-channel sample store on the board's tick clock (block unwrap; samples per block taken from each frame), roll-mode canvas drawing, legend, CSV export, `TRACE_COLORS` (one per A0–A7). |
| `extension/js/ui.js` | Side panel UI: connect/disconnect, pin table, diagnostics, event log. |
| `extension/chooser.html` / `.js` | Port-picker page opened in a normal tab (see below). |
| `extension/terminal.html` / `.css`, `js/terminal.js` | UART terminal window (TX red, RX green). |
| `extension/js/termbridge.js` | Side-panel end of the terminal: BroadcastChannel relay + history. |
| `extension/js/theme.js` | Applies the saved light/dark theme before first paint. |
| `firmware/Chrominator/uart.h` | UART bridge (Serial1 ↔ extension), Nano R4. |
| `test/sim/` | Fake Arduino core (`Arduino.h`, `avr/wdt.h`, `sim_main.cpp`) to run the firmware on a PC. |
| `test/link.test.mjs`, `test/nanor4.test.mjs`, `test/run.sh` | End-to-end tests: real firmware (Uno and Nano R4 builds) vs real `protocol.js` + `link.js`. |

## Tech stack

- **Extension:** Manifest V3, plain JavaScript ES modules (`<script type="module">`), no framework,
  no build step, no npm dependencies. Web Serial API, `chrome.sidePanel`, `chrome.tabs`, `chrome.runtime` messaging.
- **Firmware:** Arduino C++ (Arduino IDE 2.x / arduino-cli). No libraries beyond the core.
  Uses `avr/wdt.h` on the Uno; `WDT.h` on the R4.
- **Tests:** g++ (C++17) builds the firmware for the PC; Node 20+ runs the test (built-in `node:assert`).

## Protocol essentials (details in docs/PROTOCOL.md)

- 115200 8N1, no flow control. Binary frames: `A5 LEN SEQ CMD DATA… CRC8` (poly 0x07, init 0, over LEN..DATA).
- Replies use `CMD | 0x80` and the request's SEQ; DATA[0] is a status byte. Events use SEQ 0.
- Host PINGs every 250 ms; link **LOST** after 1000 ms of silence; requests time out at 400 ms;
  user actions retry twice. All commands are idempotent.
- Board fails safe (all pins INPUT, latch LOW) after 1500 ms without a valid frame, sets the
  FAILSAFE flag and sends EVT_FAILSAFE. Hardware watchdog ~1 s.
- **Capture** (protocol v2): ADC pins in mode 5 are sampled every 1024 µs (Uno) and streamed as
  EVT_CAPTURE frames, one per channel per 32-sample block, 10-bit packed LSB-first; block number
  u16 gives time. Up to 4 blocks are queued on the board. See the *Capture* section of PROTOCOL.md.
- **The board is the source of truth for pin state.** After link recovery, a FAILSAFE/NEEDS_HELLO
  ping flag, or EVT_BOOT, the host re-reads config (and HELLO + caps after a reboot) and redraws.

**When changing the protocol, update all three together:** `docs/PROTOCOL.md`, the firmware
constants/handlers, and `extension/js/protocol.js` (+ `link.js` if behaviour changes). Bump
`PROTO_VERSION` for incompatible changes. Add or extend a test in `test/link.test.mjs`.

## Hard-won rules — do not undo

- **Port picker:** Chrome cannot show the serial picker in the side panel (`requestPort()` rejects
  at once with `NotFoundError`, indistinguishable from a cancel) **or in a popup-type window**.
  `choosePort()` tries the panel first and, if it fails in under 700 ms, opens `chooser.html` in a
  **normal tab** (`chrome.tabs.create`). The tab sends `port-chosen` / `port-cancelled` /
  `port-error` back via `chrome.runtime.sendMessage` and closes itself. Never silently ignore a
  failed selection; always log *No port selected.* or the error.
- **No popup UI**: a popup closes when focus leaves it and would drop the connection.
- **Never `Serial.print` debug output in the firmware**: every byte on the port must be a frame.
- **Never use `digitalRead()` on PWM pins** in the firmware: on AVR it turns PWM off. Read pin
  levels from the port registers (`readLevel()`); keep this when porting.
- **SET_MODE** latches the pin LOW (stopping PWM) before changing mode.
- The Uno R3 auto-resets when the port opens; the host sends HELLO every ~400 ms for up to 5 s
  and ignores bootloader junk thanks to framing/CRC.
- D0/D1 are RESERVED on the Uno (USB serial). On the Nano R4 they are ordinary pins.
- **No hardware watchdog on the Nano R4.** With `WDT.begin()` running, the IDE's DFU detach into
  the bootloader failed ("Lost device after RESET?", exit status 74) and uploads needed a
  double-tap of reset. The link failsafe still applies. Don't re-enable it without testing uploads.
- **On the Renesas (R4) core `analogRead()` switches the pin to its analog function.** Without a
  capture engine, `capAdcValue()` therefore converts only channels in ANALOG mode and returns 0
  for the rest; never poll `analogRead()` on an A-pin that is in a digital mode.
- **Capture must not use a dedicated timer on the Uno**: all three are taken (millis + PWM).
  It piggybacks on Timer0's compare-A interrupt (976.5625 Hz), so the period is 1024 µs, not
  1000 µs. The host must use `hello.capturePeriodUs`, never assume 1 ms.
- **Never call `analogRead()` while capture runs**: the ADC is owned by the interrupt-driven scan.
  READ_ALL uses `capAdcValue()` (scan cache). The scan includes ANALOG channels for that reason.
- **No blocking work in the capture ISRs**; keep the UART serviceable (RX overruns at 115200
  if interrupts are held off for more than ~170 µs).
- Firmware RAM is ~69% on the Uno (capture ring is 960 B). Keep it under the IDE's 75% warning.
- `protocol.js` and `link.js` must stay free of DOM and `chrome.*` APIs so they run in Node tests.

## Code patterns

- Extension modules: `const $ = id => document.getElementById(id)`; `ChrominatorLink` extends
  `EventTarget` and emits `state`, `board`, `config`, `inputs`, `ping`, `log` (CustomEvent `detail`).
  UI reacts to events; it never parses frames itself.
- Pin rows are built once per board (`buildPins`) from the board's capabilities, then updated in
  place (`renderPin` rebuilds a row's control only when its mode changes; `updateInputs` updates values).
- **UART** (Nano R4 firmware 1.6+, `firmware/Chrominator/uart.h`): Serial1 on D0 (RX) / D1 (TX) is
  bridged to the extension. Pin modes UART_RX (6) / UART_TX (7), cap bit CAP.UART (0x40),
  UART_CONFIG (0x20), UART_TX (0x21), EVT_UART_RX (0x63), status BUSY (8); see *UART* in PROTOCOL.md.
  **RX and TX are independent** (user requirement: often only TX is used and RX's pin does
  something else): after `Serial1.begin()` (which grabs both pins) `uartRestoreGpio()` hands the
  unused pin back with `pinMode()`. The board is the source of truth: the UI reads UART state from
  the pin modes (`uartRole`, `uartIsOn`). **R4 core gotchas:** `UART::begin()` hangs if the UART is
  already open (always `end()` first; the simulator exits with "UART1 DOUBLE-BEGIN" if not);
  `UART::write()` blocks until sent, so TX bytes are queued and sent one per `loop()` pass; only
  8-data-bit formats exist. Baud capped at 115200 (user's choice). UART_TX is never retried on timeout.
- **UART panel / terminal**: `#uartSection` (a `section.buses`, above I²C Port) has RX/TX switches,
  Baud/Format (sent with `link.uartConfig` on change and on connect; remembered in
  `chrominator.uart`) and **Terminal…**, which opens `terminal.html` as a popup-type window
  (`chrome.windows.create`, allowed: it's the extension's own window from a click). The side panel
  owns the link; `js/termbridge.js` (`TerminalBridge`) relays over BroadcastChannel
  `chrominator-uart` and keeps ~256 KB of history for a newly opened window. `js/terminal.js`:
  TX text red, RX green (`--uart-tx` / `--uart-rx`, defined in all three theme blocks of
  sidepanel.css), Text/Hex view, line ending, hex send, **Live** mode (each key sent on keydown:
  Enter = line ending, Backspace 0x08, Ctrl+letter = control code, arrows = ESC [ A–D, paste sent
  whole). Text view is one stream: TX/RX runs are coloured spans sharing a line until CR/LF; line
  breaks are tracked per direction so a TX break and its RX echo end the line once. `TerminalBridge`
  sends strictly one at a time in arrival order (live keys must not overtake a BUSY retry). UART pin labels/badges use the same colours
  (`.label.uart-tx/.uart-rx`) and return to the normal text colour as GPIO.
- **I²C Port and SPI Port panels** (`#i2cSection`, `#spiSection`, both `section.buses`) are UI-only so far: `UNO_BUSES` / `BOARD_BUSES` in `ui.js` map each
  bus to its pins (I²C A4/A5; SPI D13/D11/D12/D10). Turning a bus on sets any of its pins that
  aren't INPUT back to INPUT (via SET_MODE), then `renderPin` shows them disabled with their role
  (`row.kind = 'bus:<id>'`). `busOn` lives only in the panel; the board isn't told and there is no
  protocol support yet. When bus traffic is added, it needs protocol commands (and the pins should
  become RESERVED-while-on on the board side). Each bus row has Role (Master/Slave), plus I²C
  clock and SPI clock/mode/order selects; all are placeholders that nothing reads yet. The user is
  still designing how master and slave traffic will work; don't implement it until asked.
  Sniffing was considered and dropped (I²C slave must ACK; Uno SPI slave sees one direction only).
- **Naming:** the user-facing name for CAPTURE mode and its panel is **Oscilloscope** (`MODE_NAME[5]`,
  panel heading, badge "Oscilloscope A<n>"). Code, firmware and protocol keep `capture`/`CAPTURE`.
- **Oscilloscope panel** (`#scopeSection`, heading "Oscilloscope") sits at the top, above Pins. It is shown
  whenever a board is connected: with a hint until a pin is set to Capture, or, if
  `hello.capturePeriodUs` is 0 (old firmware or a board without capture), a note to re-upload. Drawing is roll mode: newest sample at the right edge.
- **Generator panel** (`#genSection`, `section.gen`) sits right under Capture. It is a placeholder for
  the DAC (A0, 12-bit on the Nano R4 / Uno R4s; `BOARD_DAC` in `ui.js`): heading and a note only.
  The user hasn't decided what it should do yet; don't add controls or protocol until asked.
- **Startup channels**: after `link.start()` in `connect()`, `startupScope()` puts the ADC channels in
  `STARTUP_SCOPE_CHANNELS` (A0, A1) into CAPTURE, only if the board can capture and the pin is a
  plain INPUT not owned by a bus/UART. Only at connect, not on resync, so user changes stand.
- **A-pin colours**: each A-pin label in the pin list is coloured `TRACE_COLORS[adcChannel]`
  (`.label.adc`, `--c`), the same colour as its trace. Keep the two in step.
- **Capturing pins belong to the Capture panel**: a pin in CAPTURE mode is greyed out in the Pins list
  (`row.kind = 'capture'`, select disabled, colour badge "Capture A<n>"). It is stopped from the ✕ on
  its legend entry (`Scope` `onStop` → `changeMode(pin, MODE.ANALOG)`) or by All pins safe.
- Capture legend is a fixed 4-column grid: each trace sits in its channel's slot (A0–A3 on row 1,
  A4–A7 directly under them; `gridColumn`/`gridRow` set in `#renderLegend`). clear / save CSV wrap
  under the legend when the panel is narrow.
- **Timebase** is ◀ / ▶ buttons (`#tbLess`, `#tbMore`, `stepTimebase` in `ui.js`) stepping through the
  options of the now-hidden `#scopeWindow` select, which stays the state `Scope` reads.
- Scope legend: each trace has a **V** toggle (`Scope.toggleMeter`) for its live voltage readout.
  Readouts are **hidden by default**; the set of channels the user turned on is saved in
  localStorage (`chrominator.scopeMeterOn`).
- **Collapsible panels**: `initCollapsibles()` in `ui.js` turns each Capture/Pins/I²C Port/SPI Port `<h2>` into a
  `button.fold`; `section.folded` hides everything but `.sectionhead`, so header controls stay
  usable. Diagnostics and Event log are `<details>`. Fold state is saved per viewer in
  localStorage (`chrominator.folded`, keyed by section id). New panels: give them an id and a
  `.sectionhead h2`, and add their class to the selector.
- PWM slider writes are coalesced: one write in flight per pin, always ending on the latest value.
- Output read-back: an OUTPUT pin whose level disagrees with its value (300 ms after a write)
  shows `reads HIGH!/LOW!` — a short or overload hint.
- Firmware: non-blocking `loop()`; byte-at-a-time state machine (`rxByte`) with a 50 ms
  inter-byte timeout; reply built in `tx[]` with `txBegin/txU8/txU16/txU32`; little-endian.
- Styling: CSS custom properties on `:root`; dark values apply under `prefers-color-scheme: dark`
  unless `html[data-theme="light"]`, and always under `html[data-theme="dark"]` (keep the two dark
  blocks identical). The ☀/☾ switch (`setTheme` in `ui.js`) sets `data-theme` and saves
  `chrominator.theme`; `js/theme.js` (classic script in `<head>`) applies it before first paint.
  Canvas colours are read from CSS on each draw; call `scope.redraw()` after a theme change.
  Fonts: Segoe UI / system-ui for UI, Consolas for numbers. The "eye" (red LED) is the heartbeat indicator.

## Building and testing

- Firmware for the Nano R4: Arduino IDE, board "Arduino Nano R4" (Arduino UNO R4 Boards core).
  Not yet compiled or run on real hardware.
- Firmware for the Uno: Arduino IDE, board "Arduino Uno". Current size ≈ 5.6 KB flash, 1415 B RAM.
- The simulator runs capture ticks from `loop()` using `micros()` and samples its fake signal at
  each tick's scheduled time (`simAdcClockUs`), so tests stay deterministic on a busy PC.
- `test/run.sh` builds the firmware with `-DCHROMINATOR_SIM` against `test/sim` and runs
  `test/link.test.mjs`, then builds it again with `-DCHROMINATOR_SIM_NANOR4` (Nano R4 pin map, no
  capture) and runs `test/nanor4.test.mjs`. All tests must pass before committing protocol/firmware/link changes.
- The UI can be exercised in Playwright's Chromium by loading the extension unpacked
  (`launchPersistentContext`, `channel: 'chromium'`, `--load-extension`), opening
  `chrome-extension://<id>/sidepanel.html`, and replacing `navigator.serial` with a fake port
  whose streams are bridged to the simulator process.
- Real hardware can only be tested on the user's PC.

## Git

- Repo: `github.com/INVENT-HORIZONS/Chrominator`, branch `main`.
- One commit per change, short imperative summary; push after committing.
