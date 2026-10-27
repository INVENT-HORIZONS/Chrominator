// Minimal host-side stand-in for the Arduino core, so the real firmware can be compiled and run
// on a PC for protocol tests. Serial = stdin/stdout. Pin activity is logged to stderr.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>

#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define A0 14
#define A1 15
#define A2 16
#define A3 17
#define A4 18
#define A5 19
#define A6 20
#define A7 21

void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t val);
int digitalRead(uint8_t pin);
int analogRead(uint8_t pin);
void analogWrite(uint8_t pin, int val);
unsigned long millis();
unsigned long micros();
extern unsigned long simAdcClockUs;   // when non-zero, analogRead() samples the signal at this time

// AVR port-register access used by readLevel(): one "port" per pin, bit 0 = level.
volatile uint8_t *simPinRegister(uint8_t pin);
#define digitalPinToPort(p)      (p)
#define digitalPinToBitMask(p)   (1)
#define portInputRegister(port)  simPinRegister(port)

class SimSerial {
public:
  void begin(unsigned long);
  int available();
  int read();
  size_t write(uint8_t b);
  size_t write(const uint8_t *buf, size_t n);
};
extern SimSerial Serial;

// Serial1 (the Nano R4's spare UART). The simulator wires TX back to RX, like a jumper from D1 to
// D0, so tests can check both directions. Bytes sent are logged to stderr as "UART1 TX <hex>".
#define SERIAL_8N1 0x06
#define SERIAL_8N2 0x0E
#define SERIAL_8E1 0x26
#define SERIAL_8E2 0x2E
#define SERIAL_8O1 0x36
#define SERIAL_8O2 0x3E
class SimUart {
public:
  void begin(unsigned long baud, uint16_t config);
  void end();
  int available();
  int read();
  size_t write(uint8_t b);
  bool open = false;
};
extern SimUart Serial1;
