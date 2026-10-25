# CLAUDE.md

Guidance for working on Chrominator.

## What this is

A Chrome/Edge extension plus Arduino firmware for hardware debugging. The extension opens in the
browser's **side panel** (so it stays open while the user browses), connects to the board over
USB serial, and exposes the board's GPIO, PWM and ADC. The serial link is only transport: the
user picks the port and never sees baud rates, a terminal, or protocol details.

Target board: **Arduino Uno R3** (ATmega328P). A port to the **Uno R4** (Minima/WiFi) is planned;
`board_config.h` has an untested R4 block.

Follow-on to the htmlSerialPort project (`INVENT-HORIZONS/htmlSerialPort`), which established the
Web Serial patterns and the side-panel port-picker workaround used here.

## Layout

| Path | Purpose |
|---|---|
| `docs/PROTOCOL.md` | **The protocol spec. The source of truth** for frames, commands, statuses, timings. |
| `firmware/Chrominator/Chrominator.ino` | Firmware: frame parser, command handlers, link watchdog/failsafe. |
| `firmware/Chrominator/capture.h` | Capture engine: Timer0-compare tick, interrupt-driven ADC scan, 10-bit packing, block queue; AVR and simulator back ends. |
| `firmware/Chrominator/burst.h` | Burst capture: free-running ADC (prescaler 16–128), circular buffer with pre-trigger, rising/falling trigger, timeout, sending. |
| `firmware/Chrominator/board_config.h` | Per-board pin tables and capability flags; the only file a board port should need. |
| `extension/manifest.json` | MV3, `sidePanel` permission, Chrome 116+. Bump `version` on changes. |
| `extension/background.js` | Only sets `openPanelOnActionClick`. |
| `extension/sidepanel.html` / `.css` | Panel markup and styles. |
| `extension/js/protocol.js` | Constants, CRC-8, `encodeFrame`, `FrameParser`, reply decoders. No browser APIs. |
| `extension/js/link.js` | `ChrominatorLink`: request/reply by SEQ, timeouts, retries, heartbeat, LOST detection, resync. No DOM. |
| `extension/js/serial.js` | Web Serial transport (`SerialTransport`) and port selection (`choosePort`, `lastUsedPort`). |
| `extension/js/scope.js` | `Scope`: per-channel sample store on the board's tick clock (block unwrap), canvas drawing, legend, CSV export. |
| `extension/js/burst.js` | `BurstPanel`: burst controls, arm/repeat/stop, plot with trigger at t = 0, stats, CSV. |
| `extension/js/ui.js` | Side panel UI: connect/disconnect, pin table, diagnostics, event log. |
| `extension/chooser.html` / `.js` | Port-picker page opened in a normal tab (see below). |
| `test/sim/` | Fake Arduino core (`Arduino.h`, `avr/wdt.h`, `sim_main.cpp`) to run the firmware on a PC. |
| `test/link.test.mjs`, `test/run.sh` | End-to-end tests: real firmware vs real `protocol.js` + `link.js`. |

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
- **Burst** (protocol v3): BURST_START arms a one-channel free-running ADC capture (76.9k/38.5k
  8-bit ×1024, 19.2k/9.6k 10-bit ×512) with trigger and pre-trigger; results come as
  EVT_BURST_INFO then EVT_BURST_DATA frames. See the *Burst* section of PROTOCOL.md.
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
- D0/D1 are RESERVED on the Uno (USB serial).
- **Capture must not use a dedicated timer on the Uno**: all three are taken (millis + PWM).
  It piggybacks on Timer0's compare-A interrupt (976.5625 Hz), so the period is 1024 µs, not
  1000 µs. The host must use `hello.capturePeriodUs`, never assume 1 ms.
- **Never call `analogRead()` while capture runs**: the ADC is owned by the interrupt-driven scan.
  READ_ALL uses `capAdcValue()` (scan cache). The scan includes ANALOG channels for that reason.
- **No blocking work in the capture ISRs**; keep the UART serviceable (RX overruns at 115200
  if interrupts are held off for more than ~170 µs).
- **Capture and Burst share `sampleMem` (1 KB) and the ADC interrupt.** A burst stops Capture
  (`capStop()`), and `capConfigure()` does nothing while `burstBusy()`; burst.h restarts Capture
  when it has sent its data. `ISR(ADC_vect)` dispatches on `burstSampling`.
- **Capture block numbers are the time base**: after any stop, `capConfigure()` advances `capSeq`
  by the stopped time so the Scope shows a true gap rather than splicing.
- The burst ADC ISR must read the result early and stay well under 208 cycles (76.9 kS/s):
  ~140 cycles now. Don't add work to `burstSample()`.
- After a burst the ADC must be put back to the core's settings (/128, ADLAR off, ADATE off)
  or `analogRead()` misbehaves (`burstHalStop()`).
- In `link.js`, a fast burst's data can arrive in the same chunk as the BURST_START reply, so
  `startBurst()` prepares `burstRx` *before* sending and accepts any id except the previous one
  until the reply names it. Keep that.
- Firmware RAM is ~72.5% on the Uno (shared sample buffer 1 KB; receive buffer only 16 B because
  host commands are ≤ 8 bytes; board name in PROGMEM). Keep it under the IDE's 75% warning.
- `protocol.js` and `link.js` must stay free of DOM and `chrome.*` APIs so they run in Node tests.

## Code patterns

- Extension modules: `const $ = id => document.getElementById(id)`; `ChrominatorLink` extends
  `EventTarget` and emits `state`, `board`, `config`, `inputs`, `ping`, `log` (CustomEvent `detail`).
  UI reacts to events; it never parses frames itself.
- Pin rows are built once per board (`buildPins`) from the board's capabilities, then updated in
  place (`renderPin` rebuilds a row's control only when its mode changes; `updateInputs` updates values).
- **Buses section (I²C / SPI) is UI-only so far**: `UNO_BUSES` / `BOARD_BUSES` in `ui.js` map each
  bus to its pins (I²C A4/A5; SPI D13/D11/D12/D10). Turning a bus on sets any of its pins that
  aren't INPUT back to INPUT (via SET_MODE), then `renderPin` shows them disabled with their role
  (`row.kind = 'bus:<id>'`). `busOn` lives only in the panel; the board isn't told and there is no
  protocol support yet. When bus traffic is added, it needs protocol commands (and the pins should
  become RESERVED-while-on on the board side).
- **Capturing pins belong to the Scope**: a pin in CAPTURE mode is greyed out in the Pins list
  (`row.kind = 'capture'`, select disabled, colour badge "Scope A<n>"). It is stopped from the ✕ on
  its legend entry (`Scope` `onStop` → `changeMode(pin, MODE.ANALOG)`) or by All pins safe.
- **Collapsible panels**: `initCollapsibles()` in `ui.js` turns each Buses/Pins/Scope `<h2>` into a
  `button.fold`; `section.folded` hides everything but `.sectionhead`, so header controls stay
  usable. Diagnostics and Event log are `<details>`. Fold state is saved per viewer in
  localStorage (`chrominator.folded`, keyed by section id). New panels: give them an id and a
  `.sectionhead h2`, and add their class to the selector.
- Burst panel: channels whose pin is OUTPUT/PWM or on a bus are disabled in its channel list
  (`refreshChannels()` on every config change). Repeat re-arms 150 ms after each result.
- PWM slider writes are coalesced: one write in flight per pin, always ending on the latest value.
- Output read-back: an OUTPUT pin whose level disagrees with its value (300 ms after a write)
  shows `reads HIGH!/LOW!` — a short or overload hint.
- Firmware: non-blocking `loop()`; byte-at-a-time state machine (`rxByte`) with a 50 ms
  inter-byte timeout; reply built in `tx[]` with `txBegin/txU8/txU16/txU32`; little-endian.
- Styling: CSS custom properties on `:root` with a `prefers-color-scheme: dark` override;
  Segoe UI / system-ui for UI, Consolas for numbers. The "eye" (red LED) is the heartbeat indicator.

## Building and testing

- Firmware for the Uno: Arduino IDE, board "Arduino Uno". Current size ≈ 7.4 KB flash, 1485 B RAM (72.5%).
- The simulator runs capture ticks from `loop()` using `micros()` and samples its fake signal at
  each tick's scheduled time (`simAdcClockUs`), so tests stay deterministic on a busy PC.
- `test/run.sh` builds the firmware with `-DCHROMINATOR_SIM` against `test/sim` and runs
  `test/link.test.mjs`. All tests must pass before committing protocol/firmware/link changes.
- The UI can be exercised in Playwright's Chromium by loading the extension unpacked
  (`launchPersistentContext`, `channel: 'chromium'`, `--load-extension`), opening
  `chrome-extension://<id>/sidepanel.html`, and replacing `navigator.serial` with a fake port
  whose streams are bridged to the simulator process.
- Real hardware can only be tested on the user's PC.

## Git

- Repo: `github.com/INVENT-HORIZONS/Chrominator`, branch `main`.
- One commit per change, short imperative summary; push after committing.
