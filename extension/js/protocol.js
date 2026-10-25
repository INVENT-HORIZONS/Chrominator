// Chrominator protocol v3 — framing, CRC and message encoding/decoding.
// Pure JavaScript with no browser APIs, so it also runs under Node for tests.
// Spec: docs/PROTOCOL.md. Keep the constants here in step with firmware/Chrominator/Chrominator.ino.

export const PROTO_VERSION = 3;
export const SOF = 0xA5;
export const MAX_DATA = 48;
export const BYTE_TIMEOUT_MS = 50;

export const CMD = Object.freeze({
  PING: 0x01, HELLO: 0x02, GET_CAPS: 0x03, GET_CONFIG: 0x04,
  SET_MODE: 0x10, WRITE: 0x11, READ_ALL: 0x12, RESET_PINS: 0x13,
  BURST_START: 0x20, BURST_CANCEL: 0x21,
  EVT_BOOT: 0x60, EVT_FAILSAFE: 0x61, EVT_CAPTURE: 0x62, EVT_BURST_INFO: 0x63, EVT_BURST_DATA: 0x64
});
export const REPLY = 0x80;

export const STATUS_TEXT = Object.freeze({
  0: 'OK', 1: 'Unknown command', 2: 'Bad length', 3: 'Bad pin', 4: 'Mode not supported on this pin',
  5: 'Value out of range', 6: 'Pin is reserved by the board', 7: 'Pin is not an output'
});

export const MODE = Object.freeze({ INPUT: 0, PULLUP: 1, OUTPUT: 2, PWM: 3, ANALOG: 4, CAPTURE: 5 });
export const MODE_NAME = Object.freeze(['Input', 'Pull-up', 'Output', 'PWM', 'Analog', 'Capture']);

export const CAP = Object.freeze({ DIN: 0x01, DOUT: 0x02, PWM: 0x04, ADC: 0x08, PULLUP: 0x10, CAPTURE: 0x20, RESERVED: 0x80 });

export const FLAG = Object.freeze({ FAILSAFE: 0x01, NEEDS_HELLO: 0x02 });

export const BOARD_NAME = Object.freeze({ 1: 'Arduino Uno R3', 2: 'Arduino Uno R4 Minima', 3: 'Arduino Uno R4 WiFi' });

// CRC-8, polynomial 0x07, init 0x00. crc8(ascii "123456789") === 0xF4.
export function crc8(bytes, crc = 0) {
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF;
  }
  return crc;
}

export function encodeFrame(seq, cmd, data = []) {
  if (data.length > MAX_DATA) throw new RangeError(`frame data too long (${data.length})`);
  const body = [data.length, seq & 0xFF, cmd & 0xFF, ...data];
  return Uint8Array.from([SOF, ...body, crc8(body)]);
}

// Incremental frame parser. Feed it raw bytes; it calls onFrame({seq, cmd, data}) for each
// valid frame and keeps counts of discarded bytes and CRC errors.
export class FrameParser {
  constructor(onFrame, now = () => Date.now()) {
    this.onFrame = onFrame;
    this.now = now;
    this.stats = { frames: 0, crcErrors: 0, junkBytes: 0, timeouts: 0 };
    this.reset();
  }
  reset() { this.state = 0; this.buf = []; }

  push(bytes) {
    const t = this.now();
    if (this.state !== 0 && t - this.lastByte > BYTE_TIMEOUT_MS) { this.stats.timeouts++; this.reset(); }
    this.lastByte = t;
    for (const b of bytes) this.#byte(b);
  }

  #byte(b) {
    switch (this.state) {
      case 0:                                   // waiting for SOF
        if (b === SOF) { this.state = 1; this.buf = []; } else this.stats.junkBytes++;
        break;
      case 1:                                   // LEN
        if (b > MAX_DATA) { this.stats.junkBytes++; this.state = b === SOF ? 1 : 0; break; }
        this.len = b; this.buf = [b]; this.state = 2;
        break;
      case 2:                                   // SEQ, CMD, DATA
        this.buf.push(b);
        if (this.buf.length === this.len + 3) this.state = 3;
        break;
      case 3: {                                 // CRC
        this.state = 0;
        if (crc8(this.buf) !== b) { this.stats.crcErrors++; break; }
        this.stats.frames++;
        const [, seq, cmd, ...data] = this.buf;
        this.onFrame({ seq, cmd, data: Uint8Array.from(data) });
        break;
      }
    }
  }
}

// ---------- reply decoders (data[0] is the status byte, already checked as OK) ----------
const u16 = (d, i) => d[i] | (d[i + 1] << 8);
const u32 = (d, i) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;

export function decodePing(d) {
  return { flags: d[1], uptimeMs: u32(d, 2), captureOverruns: u16(d, 6), captureDropped: u16(d, 8) };
}

export function decodeHello(d) {
  return {
    proto: d[1], fwMajor: d[2], fwMinor: d[3], boardId: d[4], numPins: d[5], adcBits: d[6],
    vrefMv: u16(d, 7), linkTimeoutMs: u16(d, 9), capturePeriodUs: u16(d, 11), burstSamples: u16(d, 13),
    boardName: String.fromCharCode(...d.slice(15)) || BOARD_NAME[d[4]] || `Board ${d[4]}`
  };
}

export function decodeCaps(d) {
  const n = d[1], pins = [];
  for (let p = 0; p < n; p++) {
    const adc = d[2 + p * 2 + 1];
    pins.push({ caps: d[2 + p * 2], adcChannel: adc === 0xFF ? null : adc });
  }
  return pins;
}

export function decodeConfig(d) {
  const n = d[1], pins = [];
  for (let p = 0; p < n; p++) pins.push({ mode: d[2 + p * 2], value: d[2 + p * 2 + 1] });
  return pins;
}

export function decodeReadAll(d) {
  const levels = u32(d, 1), n = d[5], adc = [];
  for (let i = 0; i < n; i++) adc.push(u16(d, 6 + i * 2));
  return { levels, adc };
}

// EVT_CAPTURE: one block of samples for one ADC channel, packed LSB-first, `bits` bits each.
export function decodeCapture(d) {
  const block = u16(d, 0), channel = d[2], count = d[3], bits = d[4];
  const samples = new Uint16Array(count), mask = (1 << bits) - 1;
  for (let k = 0; k < count; k++) {
    const bit = k * bits, i = 5 + (bit >> 3);
    const word = d[i] | (d[i + 1] << 8) | ((d[i + 2] ?? 0) << 16);
    samples[k] = (word >>> (bit & 7)) & mask;
  }
  return { block, channel, samples };
}

// ---------- Burst ----------
// Rate codes the Uno firmware supports (burst.h). Period and bit depth come back from the board too.
export const BURST_RATES = Object.freeze([
  { code: 0, periodUs: 13, bits: 8, label: '76.9 kS/s · 8-bit' },
  { code: 1, periodUs: 26, bits: 8, label: '38.5 kS/s · 8-bit' },
  { code: 2, periodUs: 52, bits: 10, label: '19.2 kS/s · 10-bit' },
  { code: 3, periodUs: 104, bits: 10, label: '9.6 kS/s · 10-bit' }
]);
export const TRIGGER = Object.freeze({ NONE: 0, RISING: 1, FALLING: 2 });
export const BURST_RESULT = Object.freeze({ OK: 0, TIMEOUT: 1, CANCELLED: 2 });

export function encodeBurstStart({ channel, rate, trigger = 0, level = 512, prePercent = 25, timeoutMs = 0 }) {
  return [channel, rate, trigger, level & 0xFF, level >> 8, prePercent, timeoutMs & 0xFF, timeoutMs >> 8];
}
export function decodeBurstStart(d) {
  return { id: d[1], samples: u16(d, 2), triggerIndex: u16(d, 4), periodNs: u32(d, 6), bits: d[10] };
}
export function decodeBurstInfo(d) {
  return { id: d[0], result: d[1], channel: d[2], bits: d[3], samples: u16(d, 4), triggerIndex: u16(d, 6), periodNs: u32(d, 8) };
}
export function decodeBurstData(d, bits) {
  const id = d[0], offset = u16(d, 1), count = d[3];
  const samples = new Uint16Array(count);
  for (let i = 0; i < count; i++) samples[i] = bits === 8 ? d[4 + i] : u16(d, 4 + 2 * i);
  return { id, offset, samples };
}

// Uno-style pin labels: D0..D13 then A0..A5 for ADC pins.
export function pinLabel(pin, caps) {
  return caps?.adcChannel != null ? `A${caps.adcChannel}` : `D${pin}`;
}
