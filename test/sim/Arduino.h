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
