# Chrominator serial protocol — version 1

Binary request/reply protocol between the Chrominator extension (host) and the board firmware.
The host is always the one that asks; the board only speaks unprompted for two events
(boot and failsafe).

## Physical link

| Setting | Value |
|---|---|
| Baud | 115200 |
| Format | 8 data bits, no parity, 1 stop bit (8N1) |
| Flow control | none |
| Byte order | little-endian for all multi-byte numbers |

Opening the port on an Uno R3 pulses DTR, which resets the board (auto-reset). The bootloader
runs for about 1.5 s and may print junk; framing and CRC make the host ignore it.

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
| 7 | WRONG_MODE | WRITE to a pin that is not in OUTPUT or PWM mode |

## Pin model

Pins are numbered as the board numbers them (Uno: D0–D13 = 0–13, A0–A5 = 14–19).

**Modes**

| Code | Mode | WRITE value |
|---|---|---|
| 0 | INPUT (high impedance) | — |
| 1 | INPUT_PULLUP | — |
| 2 | OUTPUT | 0 = LOW, 1 = HIGH |
| 3 | PWM | duty 0–255 |
| 4 | ANALOG (ADC input) | — |

**Capability flags** (one byte per pin, from GET_CAPS)

| Bit | Flag |
|---|---|
| 0 | DIN — can be a digital input |
| 1 | DOUT — can be a digital output |
| 2 | PWM |
| 3 | ADC |
| 4 | PULLUP — has an internal pull-up |
| 7 | RESERVED — used by the board, not controllable |

The **safe state** is every non-reserved pin in INPUT mode with its output latch LOW
(high impedance, no pull-up, PWM off). The board starts in the safe state and returns to it
on RESET_PINS or failsafe.

## Commands

| CMD | Name | Request DATA | Reply DATA after status |
|---|---|---|---|
| 0x01 | PING | — | flags u8, uptime_ms u32 |
| 0x02 | HELLO | — | proto u8, fw_major u8, fw_minor u8, board_id u8, num_pins u8, adc_bits u8, vref_mV u16, link_timeout_ms u16, board name (ASCII, rest of frame) |
| 0x03 | GET_CAPS | — | num_pins u8, then per pin: flags u8, adc_channel u8 (0xFF = none) |
| 0x04 | GET_CONFIG | — | num_pins u8, then per pin: mode u8, value u8 |
| 0x10 | SET_MODE | pin u8, mode u8 | — |
| 0x11 | WRITE | pin u8, value u8 | — |
| 0x12 | READ_ALL | — | levels u32 (bit n = pin n), adc_count u8, adc_count × u16 raw readings by channel |
| 0x13 | RESET_PINS | — | — |

**Board IDs:** 1 = Arduino Uno R3, 2 = Uno R4 Minima, 3 = Uno R4 WiFi.

Notes:
- **SET_MODE** puts the pin's latch LOW and PWM off before changing mode, so an output always
  starts LOW and a PWM pin starts at duty 0.
- **READ_ALL** reports the actual pin level for every pin, read from the port register so that
  reading a PWM pin does not stop its PWM. For a PWM pin the level is whatever the waveform is at
  that instant. ADC readings are taken for every ADC channel regardless of mode; the host only
  shows them for pins in ANALOG mode.
- **GET_CONFIG** also clears the PING `FAILSAFE` flag.
- All commands are idempotent, so the host may safely retry any of them.

## Board events (SEQ = 0)

| CMD | Name | DATA |
|---|---|---|
| 0x60 | EVT_BOOT | proto u8, fw_major u8, fw_minor u8, board_id u8 |
| 0x61 | EVT_FAILSAFE | — |

EVT_BOOT is sent once when the firmware starts. EVT_FAILSAFE is sent when the link watchdog
trips (the host may not receive it, which is why the PING flag also records it).

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
- A hardware watchdog (about 1 s) resets the board if the firmware ever hangs.
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
