# Chrominator serial protocol — version 2

*Version 2 adds analog Capture (mode 5, EVT_CAPTURE), the capture period in HELLO and capture
counters in PING. A version-1 board is rejected by the extension with a message to re-flash.*

Binary request/reply protocol between the Chrominator extension (host) and the board firmware.
The host is always the one that asks; the board only speaks unprompted for events
(boot, failsafe and capture data).

## Physical link

| Setting | Value |
|---|---|
| Baud | 115200 |
| Format | 8 data bits, no parity, 1 stop bit (8N1) |
| Flow control | none |
| Byte order | little-endian for all multi-byte numbers |

Opening the port on an Uno R3 pulses DTR, which resets the board (auto-reset). The bootloader
runs for about 1.5 s and may print junk; framing and CRC make the host ignore it. The Nano R4
uses native USB: the baud rate is ignored and opening the port does not reset it.

## Frame format

```
+------+-----+-----+-----+-----------------+------+
| SOF  | LEN | SEQ | CMD | DATA (LEN bytes) | CRC  |
| 0xA5 |  1  |  1  |  1  |   0..48 bytes    |  1   |
+------+-----+-----+-----+-----------------+------+
```

- **SOF**: start of frame, always `0xA5`.
- **LEN**: number of DATA bytes, 0–48. A frame with LEN > 48 is discarded.
- **SEQ**: sequence number. The host uses 1–255 (wrapping, skipping 0); the reply carries the same
  SEQ so the host can match it. Board events use SEQ 0.
- **CMD**: command code. A reply uses the request's code with bit 7 set (`CMD | 0x80`).
- **CRC**: CRC-8, polynomial `0x07`, initial value `0x00`, no reflection, no final XOR,
  computed over LEN, SEQ, CMD and DATA (not SOF). Check value: CRC of ASCII `"123456789"` is `0xF4`.

### Receiver rules (both ends)
1. Wait for `0xA5`; ignore anything else.
2. Read LEN, SEQ, CMD, DATA and CRC. If more than **50 ms** pass between two bytes of a frame,
   drop the partial frame and go back to step 1.
3. If LEN > 48 or the CRC does not match, drop the frame silently and go back to step 1.
   The board never replies to a bad frame; the host's timeout and retry recover it.

## Replies and status codes

Every reply's DATA starts with a status byte. On any status other than OK, the rest of the
reply is empty.

| Code | Name | Meaning |
|---|---|---|
| 0 | OK | Done |
| 1 | UNKNOWN_CMD | Command code not recognised |
| 2 | BAD_LENGTH | DATA length wrong for this command |
| 3 | BAD_PIN | Pin number out of range |
| 4 | BAD_MODE | Mode not supported on this pin |
| 5 | BAD_VALUE | Value out of range for the pin's mode |
| 6 | RESERVED_PIN | Pin is used by the board itself (e.g. D0/D1 serial) |
| 7 | WRONG_MODE | WRITE to a pin that is not in OUTPUT or PWM mode; UART_TX while TX is off |
| 8 | BUSY | UART_TX: the board's TX queue has no room; wait and send again |

## Pin model

Pins are numbered as the board numbers them (Uno: D0–D13 = 0–13, A0–A5 = 14–19;
Nano R4: D0–D13 = 0–13, A0–A7 = 14–21).

**Modes**

| Code | Mode | WRITE value |
|---|---|---|
| 0 | INPUT (high impedance) | — |
| 1 | INPUT_PULLUP | — |
| 2 | OUTPUT | 0 = LOW, 1 = HIGH |
| 3 | PWM | duty 0–255 |
| 4 | ANALOG (ADC input) | — |
| 5 | CAPTURE (ADC input, streamed — see *Capture*) | — |
| 6 | UART_RX (the UART's RX pin — see *UART*) | — |
| 7 | UART_TX (the UART's TX pin — see *UART*) | — |

**Capability flags** (one byte per pin, from GET_CAPS)

| Bit | Flag |
|---|---|
| 0 | DIN — can be a digital input |
| 1 | DOUT — can be a digital output |
| 2 | PWM |
| 3 | ADC |
| 4 | PULLUP — has an internal pull-up |
| 5 | CAPTURE — can stream samples in CAPTURE mode |
| 6 | UART — can be the UART's RX or TX pin (Nano R4: D0 = RX, D1 = TX) |
| 7 | RESERVED — used by the board, not controllable |

The **safe state** is every non-reserved pin in INPUT mode with its output latch LOW
(high impedance, no pull-up, PWM off). The board starts in the safe state and returns to it
on RESET_PINS or failsafe.

## Commands

| CMD | Name | Request DATA | Reply DATA after status |
|---|---|---|---|
| 0x01 | PING | — | flags u8, uptime_ms u32, capture_overruns u16, capture_dropped u16 |
| 0x02 | HELLO | — | proto u8, fw_major u8, fw_minor u8, board_id u8, num_pins u8, adc_bits u8, vref_mV u16, link_timeout_ms u16, capture_period_us u16 (0 = no capture), board name (ASCII, rest of frame) |
| 0x03 | GET_CAPS | — | num_pins u8, then per pin: flags u8, adc_channel u8 (0xFF = none) |
| 0x04 | GET_CONFIG | — | num_pins u8, then per pin: mode u8, value u8 |
| 0x10 | SET_MODE | pin u8, mode u8 | — |
| 0x11 | WRITE | pin u8, value u8 | — |
| 0x12 | READ_ALL | — | levels u32 (bit n = pin n), adc_count u8, adc_count × u16 raw readings by channel |
| 0x13 | RESET_PINS | — | — |
| 0x20 | UART_CONFIG | baud u32 (300–115200), format u8 | — |
| 0x21 | UART_TX | 1–48 bytes to send | — (status BUSY if the queue is full) |

**Board IDs:** 1 = Arduino Uno R3, 2 = Uno R4 Minima, 3 = Uno R4 WiFi, 4 = Arduino Nano R4.

Notes:
- **SET_MODE** puts the pin's latch LOW and PWM off before changing mode, so an output always
  starts LOW and a PWM pin starts at duty 0.
- **READ_ALL** reports the actual pin level for every pin, read from the port register so that
  reading a PWM pin does not stop its PWM. For a PWM pin the level is whatever the waveform is at
  that instant. ADC readings are taken for every ADC channel regardless of mode; the host only
  shows them for pins in ANALOG or CAPTURE mode. While any pin is in CAPTURE mode, the readings
  come from the capture scan (no `analogRead()`), so channels in neither ANALOG nor CAPTURE mode
  report a stale value. On a board without capture (capture_period_us = 0, e.g. the Nano R4) only
  channels in ANALOG mode are converted and the others report 0, because the R4 core's
  `analogRead()` would take the pin away from digital use.
- **GET_CONFIG** also clears the PING `FAILSAFE` flag.
- All commands are idempotent, so the host may safely retry any of them.

## Board events (SEQ = 0)

| CMD | Name | DATA |
|---|---|---|
| 0x60 | EVT_BOOT | proto u8, fw_major u8, fw_minor u8, board_id u8 |
| 0x61 | EVT_FAILSAFE | — |
| 0x62 | EVT_CAPTURE | block u16, adc_channel u8, count u8, bits u8, packed samples |
| 0x63 | EVT_UART_RX | 1–32 bytes received on the UART's RX pin |

EVT_BOOT is sent once when the firmware starts. EVT_FAILSAFE is sent when the link watchdog
trips (the host may not receive it, which is why the PING flag also records it).

## Capture

Putting one or more ADC pins in **CAPTURE** mode starts a fixed-rate sampler on the board.

- **Sample clock:** one tick every `capture_period_us` (from HELLO). Nano R4: **10 000 µs
  (100 samples/s)**, ticks run from the main loop on `micros()`, each sample taken within one loop
  pass of its scheduled time. Uno R3: **1024 µs (976.5625 samples/s)**, from a Timer0 compare-match interrupt. Timer0 already drives `millis()`
  and the PWM on D5/D6, so no timer or PWM pin is given up. Changing the PWM duty on D6 moves the
  compare point and can shift one sample by up to one period.
- **Scan:** at each tick the ADC converts every channel in CAPTURE *or* ANALOG mode, one after
  another, driven by the ADC-complete interrupt (about 104 µs per channel). All CAPTURE channels
  are therefore sampled within the same tick and line up sample-for-sample.
- **Blocks:** samples are packed into blocks of *N* per channel, the `count` field of every
  EVT_CAPTURE frame (Uno **32**, Nano R4 **8**; fixed per board). A finished block is sent as
  one EVT_CAPTURE frame per CAPTURE channel, all carrying the same block number. A block covers
  *N* ticks (32.768 ms on the Uno, 80 ms on the Nano R4).
- **Packing:** sample *k* occupies bits `k*bits … k*bits+bits-1` of the payload, least significant
  bit first (little-endian bit stream). `bits` is in every frame: Uno 10 bits × 32 samples = 40
  bytes (DATA 45 bytes); Nano R4 14 bits × 8 samples = 14 bytes (DATA 19 bytes).
- **Timing:** sample *k* of block *b* was taken at tick `b*N + k`. Block numbers are 16-bit and
  wrap; the host unwraps them. A missing number is a gap. A large backwards jump means the board
  restarted.
- **Queue:** the Uno holds up to 4 blocks (3 finished + 1 filling, 960 bytes of SRAM); the Nano R4 16. If the
  host cannot keep up, the oldest unsent data is overwritten, `capture_dropped` (PING) counts it
  and the block number still advances so the host sees the gap. `capture_overruns` counts ticks
  skipped because the previous scan had not finished.
- **Reconfiguration:** any change of a pin into or out of ANALOG/CAPTURE restarts the sampler;
  the partly filled block and any queued blocks are discarded (a short gap on the other channels).
  Failsafe and RESET_PINS stop capture.
- **Bandwidth:** on the Uno each channel costs 50 bytes per 32.768 ms ≈ 1.5 kB/s; all six channels
  use about 9.2 kB/s of the link's 11.5 kB/s, leaving room for PING and READ_ALL. On the Nano R4
  each channel costs 24 bytes per 80 ms = 300 B/s, 2.4 kB/s for all eight.

## UART

Boards whose pins have the UART capability (Nano R4 firmware 1.6+: `Serial1`, **D0 = RX, D1 = TX**)
bridge that UART to the host.

- **RX and TX are independent.** SET_MODE D0 → UART_RX turns on receiving; SET_MODE D1 → UART_TX
  turns on sending. Either can be on alone: the other pin stays an ordinary GPIO pin in whatever
  mode it has (often only TX is used and RX's pin does something else). Any other mode on a UART
  pin turns that half off; with both off the UART is stopped. Failsafe and RESET_PINS stop it.
  UART_RX is only accepted on the RX pin and UART_TX only on the TX pin (else BAD_MODE).
- **UART_CONFIG** sets baud and frame format at any time; a running UART restarts with the new
  settings. Default after boot: 9600, 8N1. Baud is limited to **300–115200** (else BAD_VALUE), which
  keeps the RX stream far below the USB link's capacity. Format codes (8 data bits only, the R4
  core's limit): 0 = 8N1, 1 = 8N2, 2 = 8E1, 3 = 8E2, 4 = 8O1, 5 = 8O2.
- **UART_TX** queues bytes (256-byte queue); the board sends them one per main-loop pass, so a slow
  baud rate never stalls the link. It is **not idempotent**: the host must not retry it on a
  timeout. If the queue is full the reply is BUSY and nothing is queued; the host waits and resends.
  Status WRONG_MODE if TX is off.
- **EVT_UART_RX** carries received bytes, sent when 32 have arrived or 5 ms after the first byte of
  a partial chunk. Bytes received while RX is off are discarded. Bursts at 115200 are absorbed by
  the board's RX buffer and drained over USB.

## Heartbeat and disconnection detection

**Host side**
- Sends PING every **250 ms** while the port is open.
- Every valid frame received (any reply or event) counts as a sign of life.
- If nothing valid arrives for **1000 ms**, the link is **LOST**. The host keeps the port open,
  keeps pinging, and stops other polling. When replies resume, the link is **UP** again and
  the host resynchronises (below).
- If the port itself fails (USB unplugged, read error), the host is **DISCONNECTED** and closes
  the port.
- Requests time out after **400 ms**. User actions (SET_MODE, WRITE, RESET_PINS) are retried
  up to 2 more times.

**Board side**
- A hardware watchdog (about 1 s) resets the board if the firmware ever hangs (Uno only; the
  Nano R4 runs without one because it blocked the IDE's automatic upload reset).
- After the host has said HELLO, the board expects a valid frame at least every
  `link_timeout_ms` (**1500 ms**). If none arrives, the board **fails safe**: all pins go to the
  safe state, the `FAILSAFE` flag is set, EVT_FAILSAFE is sent, and the board waits for the
  host to come back. It does not fail safe again until it has heard from the host.

**PING flags**

| Bit | Flag | Set when | Cleared by |
|---|---|---|---|
| 0 | FAILSAFE | The link watchdog put the pins in the safe state | GET_CONFIG |
| 1 | NEEDS_HELLO | Board has (re)booted and no HELLO yet | HELLO |

**Resynchronisation:** on link-up, and whenever a PING reply has a flag set, the host runs
HELLO (if NEEDS_HELLO) → GET_CAPS → GET_CONFIG, and rebuilds its view of the pins from the
board's answer. The board is always the source of truth for pin state.

## Connection sequence

1. Open the port at 115200 8N1.
2. Send HELLO every 300 ms until a HELLO reply arrives (up to 5 s; covers the Uno's
   auto-reset and bootloader). An EVT_BOOT also triggers an immediate HELLO.
3. GET_CAPS, then GET_CONFIG.
4. Start PING (250 ms) and READ_ALL polling (100 ms by default).
