// Chrominator — UART bridge (included by Chrominator.ino after its state is declared).
//
// The board's spare hardware UART (Nano R4: Serial1, RX D0, TX D1) is bridged to the extension's
// terminal. RX and TX are switched on independently with the pin modes UART_RX / UART_TX, so a
// sketch-under-test can use just TX while RX's pin stays an ordinary GPIO.
//
//  - CMD_UART_CONFIG sets baud and frame format (kept across RX/TX on/off, reset to 9600 8N1 at boot).
//  - CMD_UART_TX queues bytes; loop() sends one byte per pass. The core's UART write blocks until the
//    byte is on the wire, so writing a whole frame at 1200 baud would stall the link for ~400 ms.
//  - Received bytes go to the host as EVT_UART_RX frames (up to 32 bytes, or after 5 ms idle).
//  - Failsafe / RESET_PINS put both pins back to INPUT, which stops the UART.
#pragma once

#if defined(UART_RX_PIN)

#define UART_TXQ_SIZE   256              // bytes queued for TX (power of two)
#define UART_RX_CHUNK   32               // max bytes per EVT_UART_RX frame
#define UART_RX_IDLE_MS 5                // flush a partial RX chunk after this much quiet
#define UART_MAX_BAUD   115200UL

// Wire format index -> core config. The Renesas core supports 8 data bits only.
static const uint16_t UART_FORMATS[] = { SERIAL_8N1, SERIAL_8N2, SERIAL_8E1, SERIAL_8E2, SERIAL_8O1, SERIAL_8O2 };
#define UART_NUM_FORMATS (sizeof UART_FORMATS / sizeof UART_FORMATS[0])

static uint32_t uartBaud = 9600;
static uint8_t  uartFormat = 0;
static bool     uartRunning = false;
static uint8_t  uartTxq[UART_TXQ_SIZE];
static uint16_t uartTxHead = 0, uartTxTail = 0;   // head = next write, tail = next send
static uint8_t  uartRxBuf[UART_RX_CHUNK];
static uint8_t  uartRxN = 0;
static uint32_t uartRxFirstMs = 0;

static bool uartPinIs(uint8_t pin, uint8_t mode) {
  return (PIN_CAPS[pin] & CAP_UART) && ((mode == M_UART_RX && pin == UART_RX_PIN) || (mode == M_UART_TX && pin == UART_TX_PIN));
}

// Put a pin that is not in a UART mode back to its GPIO setting (Serial1.begin() takes both pins).
static void uartRestoreGpio(uint8_t pin) {
  switch (pinMode_[pin]) {
    case M_PULLUP: pinMode(pin, INPUT_PULLUP); break;
    case M_OUTPUT: pinMode(pin, OUTPUT); digitalWrite(pin, pinValue[pin] ? HIGH : LOW); break;
    default:       pinMode(pin, INPUT); break;
  }
}

// (Re)start or stop the UART to match the pin modes. Called after any change into or out of a
// UART mode, and after a config change.
static void uartApply() {
  bool rx = pinMode_[UART_RX_PIN] == M_UART_RX, txOn = pinMode_[UART_TX_PIN] == M_UART_TX;
  if (uartRunning) { UART_PORT.end(); uartRunning = false; }    // the core hangs if opened twice
  uartRxN = 0;
  if (!txOn) uartTxHead = uartTxTail = 0;
  if (!rx && !txOn) return;
  UART_PORT.begin(uartBaud, UART_FORMATS[uartFormat]);
  uartRunning = true;
  // begin() configured both pins for the UART; give the unused half back to GPIO.
  if (!rx)   uartRestoreGpio(UART_RX_PIN);
  if (!txOn) uartRestoreGpio(UART_TX_PIN);
}

static uint8_t uartConfigure(uint32_t baud, uint8_t format) {
  // Capped at 115200: plenty for debugging, and the RX stream stays far below the USB link's capacity.
  if (format >= UART_NUM_FORMATS || baud < 300 || baud > UART_MAX_BAUD) return ST_BAD_VALUE;
  if (baud == uartBaud && format == uartFormat) return ST_OK;
  uartBaud = baud; uartFormat = format;
  if (uartRunning) uartApply();
  return ST_OK;
}

static uint8_t uartQueue(const uint8_t *d, uint8_t n) {
  if (pinMode_[UART_TX_PIN] != M_UART_TX) return ST_WRONG_MODE;
  uint16_t used = (uint16_t)(uartTxHead - uartTxTail) & (UART_TXQ_SIZE - 1);
  if (n > UART_TXQ_SIZE - 1 - used) return ST_BUSY;             // host waits and retries
  for (uint8_t i = 0; i < n; i++) { uartTxq[uartTxHead] = d[i]; uartTxHead = (uartTxHead + 1) & (UART_TXQ_SIZE - 1); }
  return ST_OK;
}

static void uartService() {
  if (!uartRunning) return;
  if (uartTxTail != uartTxHead) {                                // one byte per pass (blocks ~1 char time)
    UART_PORT.write(uartTxq[uartTxTail]);
    uartTxTail = (uartTxTail + 1) & (UART_TXQ_SIZE - 1);
  }
  bool rxOn = pinMode_[UART_RX_PIN] == M_UART_RX;
  while (UART_PORT.available() > 0) {
    int c = UART_PORT.read();
    if (!rxOn || c < 0) continue;                                // TX only: discard (RX pin is GPIO)
    if (uartRxN == 0) uartRxFirstMs = millis();
    uartRxBuf[uartRxN++] = (uint8_t)c;
    if (uartRxN == UART_RX_CHUNK) { sendFrame(0, EVT_UART_RX, uartRxBuf, uartRxN); uartRxN = 0; }
  }
  if (uartRxN && (uint32_t)(millis() - uartRxFirstMs) >= UART_RX_IDLE_MS) { sendFrame(0, EVT_UART_RX, uartRxBuf, uartRxN); uartRxN = 0; }
}

#else   // board without a spare UART
static bool uartPinIs(uint8_t, uint8_t) { return false; }
static void uartApply() {}
static uint8_t uartConfigure(uint32_t, uint8_t) { return ST_UNKNOWN_CMD; }
static uint8_t uartQueue(const uint8_t *, uint8_t) { return ST_UNKNOWN_CMD; }
static void uartService() {}
#endif
