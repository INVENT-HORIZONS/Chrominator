// Chrominator — per-board configuration.
// Porting to a new board means adding a block here; Chrominator.ino stays the same.
#pragma once
#include <Arduino.h>

// Capability flags (see docs/PROTOCOL.md)
#define CAP_DIN       0x01
#define CAP_DOUT      0x02
#define CAP_PWM       0x04
#define CAP_ADC       0x08
#define CAP_PULLUP    0x10
#define CAP_CAPTURE   0x20
#define CAP_RESERVED  0x80

#define CAP_GPIO   (CAP_DIN | CAP_DOUT | CAP_PULLUP)
#define CAP_GPWM   (CAP_GPIO | CAP_PWM)
#define CAP_GADC   (CAP_GPIO | CAP_ADC)
#define NO_ADC     0xFF

// Capture engine implementations (capture.h)
#define CAPTURE_NONE  0
#define CAPTURE_AVR   1
#define CAPTURE_SIM   2
#define CAPTURE_POLL  3   // ticks run from loop() on micros(), samples taken with analogRead()

// CHROMINATOR_SIM builds the Uno R3 table for the PC simulator; add CHROMINATOR_SIM_NANOR4 for the Nano R4 table.
#if defined(ARDUINO_AVR_UNO) || (defined(CHROMINATOR_SIM) && !defined(CHROMINATOR_SIM_NANOR4))
  // ---------------- Arduino Uno R3 (ATmega328P) ----------------
  #define BOARD_ID        1
  #define BOARD_NAME      "Arduino Uno R3"
  #define NUM_PINS        20      // D0-D13, A0-A5 (14-19)
  #define NUM_ADC         6
  #define ADC_BITS        10
  #define VREF_MV         5000
  #define HAS_AVR_PORTS   1       // read pin levels from port registers (does not disturb PWM)
  #define CAP_GADCC       (CAP_GADC | CAP_CAPTURE)
  #define CAPTURE_PERIOD_US 1024  // Timer0 compare: 16 MHz / 64 / 256 = 976.5625 Hz
  #if defined(CHROMINATOR_SIM)
    #define CAPTURE_IMPL  CAPTURE_SIM
  #else
    #define CAPTURE_IMPL  CAPTURE_AVR
  #endif

  static const uint8_t PIN_CAPS[NUM_PINS] = {
    CAP_RESERVED, CAP_RESERVED,          // D0 RX, D1 TX: used by USB serial
    CAP_GPIO, CAP_GPWM, CAP_GPIO,        // D2, D3~, D4
    CAP_GPWM, CAP_GPWM, CAP_GPIO,        // D5~, D6~, D7
    CAP_GPIO, CAP_GPWM, CAP_GPWM,        // D8, D9~, D10~
    CAP_GPWM, CAP_GPIO, CAP_GPIO,        // D11~, D12, D13 (LED)
    CAP_GADCC, CAP_GADCC, CAP_GADCC,     // A0, A1, A2
    CAP_GADCC, CAP_GADCC, CAP_GADCC      // A3, A4 (SDA), A5 (SCL)
  };
  static const uint8_t PIN_ADC[NUM_PINS] = {
    NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC,
    NO_ADC, NO_ADC, NO_ADC, NO_ADC, 0, 1, 2, 3, 4, 5
  };
  static const uint8_t ADC_PIN[NUM_ADC] = { A0, A1, A2, A3, A4, A5 };

  #include <avr/wdt.h>
  #define HW_WATCHDOG_BEGIN()   wdt_enable(WDTO_1S)
  #define HW_WATCHDOG_KICK()    wdt_reset()
  #define ADC_SETUP()           do {} while (0)

#elif defined(ARDUINO_NANO_R4) || defined(CHROMINATOR_SIM_NANOR4)
  // The core defines ARDUINO_NANO_R4 *and* ARDUINO_UNOR4_MINIMA for the Nano R4, so this block
  // must stay ahead of the Minima block below.
  // ---------------- Arduino Nano R4 (Renesas RA4M1, 48 MHz, 5 V I/O) ----------------
  // Core: "Arduino UNO R4 Boards" (arduino:renesas_uno), board "Arduino Nano R4".
  // Pin numbers from the core's NANOR4 variant: D0-D13 = 0-13, A0-A7 = 14-21.
  // Serial is native USB, so D0/D1 (Serial1) are ordinary pins and the board does not reset
  // when the port opens. PWM on D3, D5, D6, D9, D10, D11. A0 is also the 12-bit DAC (not used yet).
  #define BOARD_ID        4
  #define BOARD_NAME      "Arduino Nano R4"
  #define NUM_PINS        22
  #define NUM_ADC         8
  #define ADC_BITS        14
  #define VREF_MV         5000
  #define HAS_AVR_PORTS   0
  // Capture: 100 samples/s per channel, timed from loop() with micros(). Full 14-bit samples,
  // 8 per block (an EVT_CAPTURE frame every 80 ms, so the trace scrolls smoothly).
  #define CAPTURE_PERIOD_US 10000
  #define CAP_BITS          14
  #define CAP_BLOCK_SAMPLES 8
  #define CAP_RING_BLOCKS   16
  #define CAP_GADCC       (CAP_GADC | CAP_CAPTURE)
  #if defined(CHROMINATOR_SIM_NANOR4)
    #define CAPTURE_IMPL  CAPTURE_SIM
  #else
    #define CAPTURE_IMPL  CAPTURE_POLL
  #endif

  static const uint8_t PIN_CAPS[NUM_PINS] = {
    CAP_GPIO, CAP_GPIO,                  // D0 RX1, D1 TX1 (free: USB is native)
    CAP_GPIO, CAP_GPWM, CAP_GPIO,        // D2, D3~, D4
    CAP_GPWM, CAP_GPWM, CAP_GPIO,        // D5~, D6~, D7
    CAP_GPIO, CAP_GPWM, CAP_GPWM,        // D8, D9~, D10~
    CAP_GPWM, CAP_GPIO, CAP_GPIO,        // D11~, D12, D13 (LED is a separate pin on the Nano R4)
    CAP_GADCC, CAP_GADCC, CAP_GADCC,     // A0 (DAC), A1, A2
    CAP_GADCC, CAP_GADCC, CAP_GADCC,     // A3, A4 (SDA), A5 (SCL)
    CAP_GADCC, CAP_GADCC                 // A6, A7
  };
  static const uint8_t PIN_ADC[NUM_PINS] = {
    NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC,
    NO_ADC, NO_ADC, NO_ADC, NO_ADC, 0, 1, 2, 3, 4, 5, 6, 7
  };
  static const uint8_t ADC_PIN[NUM_ADC] = { A0, A1, A2, A3, A4, A5, A6, A7 };

  // No hardware watchdog on the Nano R4: with it running, the IDE's automatic reset into the
  // bootloader fails ("Lost device after RESET?", exit status 74) and uploads need a double-tap
  // of reset. The link failsafe (all pins to INPUT after LINK_TIMEOUT_MS of silence) still applies.
  #define HW_WATCHDOG_BEGIN()   do {} while (0)
  #define HW_WATCHDOG_KICK()    do {} while (0)
  #if defined(CHROMINATOR_SIM_NANOR4)
    #define ADC_SETUP()           do {} while (0)
  #else
    #define ADC_SETUP()           analogReadResolution(ADC_BITS)
  #endif

#elif defined(ARDUINO_UNOR4_MINIMA) || defined(ARDUINO_UNOR4_WIFI)
  // ---------------- Arduino Uno R4 (RA4M1) — UNTESTED starting point ----------------
  #if defined(ARDUINO_UNOR4_WIFI)
    #define BOARD_ID      3
    #define BOARD_NAME    "Arduino Uno R4 WiFi"
  #else
    #define BOARD_ID      2
    #define BOARD_NAME    "Arduino Uno R4 Minima"
  #endif
  #define NUM_PINS        20
  #define NUM_ADC         6
  #define ADC_BITS        14
  #define VREF_MV         5000
  #define HAS_AVR_PORTS   0
  #define CAPTURE_IMPL    CAPTURE_NONE   // TODO: capture on the R4 (AGT timer + ADC interrupt)
  #define CAPTURE_PERIOD_US 0
  // On the R4, Serial is native USB, so D0/D1 are free (Serial1). Kept reserved for now
  // so the pin map matches the R3; unreserve once tested.
  static const uint8_t PIN_CAPS[NUM_PINS] = {
    CAP_RESERVED, CAP_RESERVED,
    CAP_GPIO, CAP_GPWM, CAP_GPIO, CAP_GPWM, CAP_GPWM, CAP_GPIO,
    CAP_GPIO, CAP_GPWM, CAP_GPWM, CAP_GPWM, CAP_GPIO, CAP_GPIO,
    CAP_GADC, CAP_GADC, CAP_GADC, CAP_GADC, CAP_GADC, CAP_GADC
  };
  static const uint8_t PIN_ADC[NUM_PINS] = {
    NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC, NO_ADC,
    NO_ADC, NO_ADC, NO_ADC, NO_ADC, 0, 1, 2, 3, 4, 5
  };
  static const uint8_t ADC_PIN[NUM_ADC] = { A0, A1, A2, A3, A4, A5 };

  #include <WDT.h>
  #define HW_WATCHDOG_BEGIN()   WDT.begin(1000)
  #define HW_WATCHDOG_KICK()    WDT.refresh()
  #define ADC_SETUP()           analogReadResolution(ADC_BITS)

#else
  #error "Chrominator: unsupported board. Add a block to board_config.h."
#endif
