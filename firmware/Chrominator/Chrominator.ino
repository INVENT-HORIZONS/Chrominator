// Chrominator firmware — exposes the board's GPIO, PWM and ADC to the Chrominator
// Chrome extension over USB serial. Protocol: docs/PROTOCOL.md (version 2).
//
// Board: Arduino Uno R3 (tested); Uno R4 support is in board_config.h (untested).
// Serial: 115200 8N1. Do not use Serial for anything else (no Serial.print debugging):
// every byte on the port must be a protocol frame.

#include "board_config.h"

// ---------------- Protocol constants ----------------
#define PROTO_VERSION     2
#define FW_MAJOR          1
#define FW_MINOR          2

#define SOF               0xA5
#define MAX_DATA          48
#define BYTE_TIMEOUT_MS   50      // gap allowed between bytes of one frame
#define LINK_TIMEOUT_MS   1500    // host silence before failsafe

enum Cmd : uint8_t {
  CMD_PING = 0x01, CMD_HELLO = 0x02, CMD_GET_CAPS = 0x03, CMD_GET_CONFIG = 0x04,
  CMD_SET_MODE = 0x10, CMD_WRITE = 0x11, CMD_READ_ALL = 0x12, CMD_RESET_PINS = 0x13,
  EVT_BOOT = 0x60, EVT_FAILSAFE = 0x61, EVT_CAPTURE = 0x62
};
enum Status : uint8_t {
  ST_OK = 0, ST_UNKNOWN_CMD = 1, ST_BAD_LENGTH = 2, ST_BAD_PIN = 3, ST_BAD_MODE = 4,
  ST_BAD_VALUE = 5, ST_RESERVED_PIN = 6, ST_WRONG_MODE = 7
};
enum Mode : uint8_t { M_INPUT = 0, M_PULLUP = 1, M_OUTPUT = 2, M_PWM = 3, M_ANALOG = 4, M_CAPTURE = 5 };

#define FLAG_FAILSAFE     0x01
#define FLAG_NEEDS_HELLO  0x02

// ---------------- State ----------------
static uint8_t pinMode_[NUM_PINS];   // current Mode per pin
static uint8_t pinValue[NUM_PINS];   // OUTPUT level or PWM duty
static uint8_t flags = FLAG_NEEDS_HELLO;
static bool hostActive = false;      // heard from host since last failsafe
static uint32_t lastFrameMs = 0;

// Receive state machine
enum RxState : uint8_t { RX_SOF, RX_LEN, RX_SEQ, RX_CMD, RX_DATA, RX_CRC };
static RxState rxState = RX_SOF;
static uint8_t rxLen, rxSeq, rxCmd, rxPos, rxCrc;
static uint8_t rxData[MAX_DATA];
static uint32_t rxLastByteMs = 0;

// Reply buffer
static uint8_t tx[MAX_DATA];
static uint8_t txLen;

// ---------------- CRC-8 (poly 0x07, init 0x00) ----------------
static uint8_t crc8Update(uint8_t crc, uint8_t b) {
  crc ^= b;
  for (uint8_t i = 0; i < 8; i++) crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
  return crc;
}

static void sendFrame(uint8_t seq, uint8_t cmd, const uint8_t *data, uint8_t len) {
  uint8_t crc = 0;
  crc = crc8Update(crc, len);
  crc = crc8Update(crc, seq);
  crc = crc8Update(crc, cmd);
  for (uint8_t i = 0; i < len; i++) crc = crc8Update(crc, data[i]);
  Serial.write(SOF);
  Serial.write(len);
  Serial.write(seq);
  Serial.write(cmd);
  if (len) Serial.write(data, len);
  Serial.write(crc);
}

#include "capture.h"     // analog Capture engine; uses sendFrame() and pinMode_[]

// Reply helpers: tx[0] is the status byte
static void txBegin(uint8_t status) { tx[0] = status; txLen = 1; }
static void txU8(uint8_t v)  { if (txLen < MAX_DATA) tx[txLen++] = v; }
static void txU16(uint16_t v) { txU8(v & 0xFF); txU8(v >> 8); }
static void txU32(uint32_t v) { txU16(v & 0xFFFF); txU16(v >> 16); }

// ---------------- Pins ----------------
static void applyMode(uint8_t pin, uint8_t mode) {
  // Latch LOW first: stops PWM and avoids enabling the pull-up by accident.
  digitalWrite(pin, LOW);
  switch (mode) {
    case M_PULLUP: pinMode(pin, INPUT_PULLUP); break;
    case M_OUTPUT:
    case M_PWM:    pinMode(pin, OUTPUT); break;
    default:       pinMode(pin, INPUT); break;   // INPUT, ANALOG and CAPTURE
  }
  pinMode_[pin] = mode;
  pinValue[pin] = 0;
}

static void safeState() {
  for (uint8_t p = 0; p < NUM_PINS; p++) {
    if (PIN_CAPS[p] & CAP_RESERVED) continue;
    applyMode(p, M_INPUT);
  }
  capConfigure();
}

static bool modeAllowed(uint8_t pin, uint8_t mode) {
  uint8_t c = PIN_CAPS[pin];
  switch (mode) {
    case M_INPUT:  return c & CAP_DIN;
    case M_PULLUP: return c & CAP_PULLUP;
    case M_OUTPUT: return c & CAP_DOUT;
    case M_PWM:    return c & CAP_PWM;
    case M_ANALOG: return c & CAP_ADC;
    case M_CAPTURE: return c & CAP_CAPTURE;
    default:       return false;
  }
}

static uint8_t readLevel(uint8_t pin) {
#if HAS_AVR_PORTS
  // Port register read: unlike digitalRead(), this does not switch off PWM on the pin.
  return (*portInputRegister(digitalPinToPort(pin)) & digitalPinToBitMask(pin)) ? 1 : 0;
#else
  if (pinMode_[pin] == M_PWM) return pinValue[pin] ? 1 : 0;   // avoid disturbing PWM
  return digitalRead(pin) ? 1 : 0;
#endif
}

// ---------------- Command handling ----------------
static void handleFrame() {
  const uint8_t seq = rxSeq, cmd = rxCmd, len = rxLen;
  const uint8_t *d = rxData;
  lastFrameMs = millis();
  hostActive = true;

  switch (cmd) {
    case CMD_PING:
      txBegin(ST_OK);
      txU8(flags);
      txU32(millis());
      txU16(capOverruns);
      txU16(capDropped);
      break;

    case CMD_HELLO: {
      flags &= ~FLAG_NEEDS_HELLO;
      txBegin(ST_OK);
      txU8(PROTO_VERSION); txU8(FW_MAJOR); txU8(FW_MINOR); txU8(BOARD_ID);
      txU8(NUM_PINS); txU8(ADC_BITS); txU16(VREF_MV); txU16(LINK_TIMEOUT_MS);
      txU16(CAPTURE_PERIOD_US);
      for (const char *s = BOARD_NAME; *s; s++) txU8((uint8_t)*s);
      break;
    }

    case CMD_GET_CAPS:
      txBegin(ST_OK);
      txU8(NUM_PINS);
      for (uint8_t p = 0; p < NUM_PINS; p++) { txU8(PIN_CAPS[p]); txU8(PIN_ADC[p]); }
      break;

    case CMD_GET_CONFIG:
      flags &= ~FLAG_FAILSAFE;
      txBegin(ST_OK);
      txU8(NUM_PINS);
      for (uint8_t p = 0; p < NUM_PINS; p++) { txU8(pinMode_[p]); txU8(pinValue[p]); }
      break;

    case CMD_SET_MODE: {
      if (len != 2) { txBegin(ST_BAD_LENGTH); break; }
      uint8_t pin = d[0], mode = d[1];
      if (pin >= NUM_PINS)                 { txBegin(ST_BAD_PIN); break; }
      if (PIN_CAPS[pin] & CAP_RESERVED)    { txBegin(ST_RESERVED_PIN); break; }
      if (!modeAllowed(pin, mode))         { txBegin(ST_BAD_MODE); break; }
      if (pinMode_[pin] != mode) {
        uint8_t was = pinMode_[pin];
        applyMode(pin, mode);
        if (was == M_ANALOG || was == M_CAPTURE || mode == M_ANALOG || mode == M_CAPTURE) capConfigure();
      }
      txBegin(ST_OK);
      break;
    }

    case CMD_WRITE: {
      if (len != 2) { txBegin(ST_BAD_LENGTH); break; }
      uint8_t pin = d[0], value = d[1];
      if (pin >= NUM_PINS)                 { txBegin(ST_BAD_PIN); break; }
      if (PIN_CAPS[pin] & CAP_RESERVED)    { txBegin(ST_RESERVED_PIN); break; }
      if (pinMode_[pin] == M_OUTPUT) {
        if (value > 1) { txBegin(ST_BAD_VALUE); break; }
        digitalWrite(pin, value ? HIGH : LOW);
      } else if (pinMode_[pin] == M_PWM) {
        analogWrite(pin, value);
      } else { txBegin(ST_WRONG_MODE); break; }
      pinValue[pin] = value;
      txBegin(ST_OK);
      break;
    }

    case CMD_READ_ALL: {
      uint32_t levels = 0;
      for (uint8_t p = 0; p < NUM_PINS; p++) if (readLevel(p)) levels |= (1UL << p);
      txBegin(ST_OK);
      txU32(levels);
      txU8(NUM_ADC);
      for (uint8_t ch = 0; ch < NUM_ADC; ch++) txU16(capAdcValue(ch));
      break;
    }

    case CMD_RESET_PINS:
      safeState();
      txBegin(ST_OK);
      break;

    default:
      txBegin(ST_UNKNOWN_CMD);
      break;
  }
  sendFrame(seq, cmd | 0x80, tx, txLen);
}

static void rxByte(uint8_t b) {
  uint32_t now = millis();
  if (rxState != RX_SOF && (uint32_t)(now - rxLastByteMs) > BYTE_TIMEOUT_MS) rxState = RX_SOF;
  rxLastByteMs = now;

  switch (rxState) {
    case RX_SOF:
      if (b == SOF) rxState = RX_LEN;
      break;
    case RX_LEN:
      if (b > MAX_DATA) { rxState = (b == SOF) ? RX_LEN : RX_SOF; break; }
      rxLen = b; rxCrc = crc8Update(0, b); rxState = RX_SEQ;
      break;
    case RX_SEQ:
      rxSeq = b; rxCrc = crc8Update(rxCrc, b); rxState = RX_CMD;
      break;
    case RX_CMD:
      rxCmd = b; rxCrc = crc8Update(rxCrc, b); rxPos = 0;
      rxState = rxLen ? RX_DATA : RX_CRC;
      break;
    case RX_DATA:
      rxData[rxPos++] = b; rxCrc = crc8Update(rxCrc, b);
      if (rxPos >= rxLen) rxState = RX_CRC;
      break;
    case RX_CRC:
      rxState = RX_SOF;
      if (b == rxCrc) handleFrame();   // bad CRC: drop silently, host will retry
      break;
  }
}

// ---------------- Arduino entry points ----------------
void setup() {
  for (uint8_t p = 0; p < NUM_PINS; p++) { pinMode_[p] = M_INPUT; pinValue[p] = 0; }
  safeState();
  ADC_SETUP();
  Serial.begin(115200);
  HW_WATCHDOG_BEGIN();
  uint8_t boot[4] = { PROTO_VERSION, FW_MAJOR, FW_MINOR, BOARD_ID };
  sendFrame(0, EVT_BOOT, boot, sizeof boot);
}

void loop() {
  HW_WATCHDOG_KICK();

  while (Serial.available() > 0) rxByte((uint8_t)Serial.read());
  capService();

  // Link watchdog: host went quiet -> put every pin in the safe state.
  if (hostActive && (uint32_t)(millis() - lastFrameMs) > LINK_TIMEOUT_MS) {
    hostActive = false;
    safeState();
    flags |= FLAG_FAILSAFE;
    sendFrame(0, EVT_FAILSAFE, nullptr, 0);
  }
}
