# Chrominator

*"I'll be back… once you reconnect the USB."*

A Chrome / Edge extension that turns an Arduino into a debugging tool you can drive from the
browser's side panel while you browse. Pick the board's port once, then set pin modes, switch
outputs, drive PWM and watch digital inputs and analog voltages live. A heartbeat watches the
link the whole time, and the board drops every pin to a safe state if the browser goes away.

![The Chrominator side panel](docs/panel.png)

## What's here

| Folder | Contents |
|---|---|
| `extension/` | The Chrome extension (Manifest V3, side panel). |
| `firmware/Chrominator/` | Arduino sketch for the board (Uno R3; Uno R4 support started). |
| `docs/PROTOCOL.md` | The serial protocol: framing, commands, heartbeat and failsafe. |
| `test/` | End-to-end tests: the real firmware, compiled for the PC, against the extension's link code. |

## Set up

**1. Flash the board** (Arduino IDE 2.x)
1. Open `firmware/Chrominator/Chrominator.ino`.
2. Board: **Arduino Uno**. Port: your Uno's COM port.
3. Upload. Then close the IDE's Serial Monitor; only one program can use the port at a time.

**2. Install the extension** (one time)
1. Go to `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension` folder.
3. Pin **Chrominator** from the puzzle-piece menu.

## Use

1. Click the Chrominator icon (the red eye) to open the side panel.
2. Click **Connect**. The first time, a tab opens: click **Choose serial port…** and pick your
   Arduino. After that, Connect goes straight to the same board; use *Choose a different port…*
   to switch.
3. The Uno resets when the port opens, so allow about two seconds before the pins appear.

| Mode | What you get |
|---|---|
| Input / Pull-up | Live HIGH/LOW level |
| Output | On/off switch; shows `reads LOW!` if the pin doesn't follow (short or overload) |
| PWM (pins marked ~) | Slider, 0–255 |
| Analog (A0–A5) | Voltage (5 V reference), raw reading and a bar |
| Capture (A0–A5) | The pin is sampled ~1000 times a second and drawn on the **Scope**; its row is greyed out, and the ✕ next to its trace in the Scope stops it (back to Analog) |

**Scope.** Put one or more analog pins in **Capture** and the Scope appears below the pins, with
every capturing channel overlaid in its own colour (shown next to the pin). The board samples
all capturing pins at the same instant, 976.6 times a second (every 1.024 ms), and sends them in
32-sample blocks; the time axis comes from the board's clock, not the PC's. Pick 1 s to 2 min
across the screen, a fixed 0–5 V or *Auto* vertical scale, **Pause** to freeze the picture
(capture carries on underneath), and **save CSV** to export everything held (about the last
2 minutes per channel). It is meant for slow signals, such as a battery voltage sagging after
it's disconnected, not as a fast oscilloscope.

**Buses.** Above the pins, switch on **I²C** (SDA A4, SCL A5) or **SPI** (SCK D13, MOSI D11,
MISO D12, SS D10). The bus's pins are put back to plain inputs, greyed out in the pin list and
labelled with their role until the bus is switched off. The clock, mode and bit-order settings
are there, but sending and receiving data isn't implemented yet.

Every panel folds up: click its heading (Buses, Pins, Scope, Diagnostics, Event log). Chrominator
remembers which ones you folded.

**All pins safe** puts every pin back to a plain input. D0/D1 carry the USB serial link and
can't be used.

**Status:** the red eye pulses with each heartbeat and the round-trip time shows on the right.
*Link lost* means the board stopped answering for a second (the port is still open and the
extension keeps trying). If the board hears nothing from the extension for 1.5 s it sets every
pin to input on its own, so an output is never left driving while nobody is watching.
*Diagnostics* shows frame counts, CRC errors, timeouts and retries.

## Test

```sh
test/run.sh          # needs g++ and Node 20+
```

This compiles the real firmware against a simulated Arduino (`test/sim`) and runs it against the
extension's `protocol.js` and `link.js`: connection, every command and error status, the
heartbeat, corrupted bytes, link loss and recovery, the board's failsafe, a board reboot, and
capture (block alignment between channels, all six channels streaming at once, stopping).
