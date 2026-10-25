// Host simulator for the Chrominator firmware. Build: see test/README.md.
// External world: D2 is tied HIGH, every other input floats LOW (HIGH with pull-up);
// ADC channel n reads a slow ramp offset by n*100 so readings change over time.
#include "Arduino.h"
#include <stdio.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <sys/time.h>

static uint8_t mode_[20], latch[20], pwm[20];
static volatile uint8_t reg[20];
static struct timeval t0;

static void updateReg(uint8_t p) {
  uint8_t lvl;
  if (mode_[p] == OUTPUT) lvl = pwm[p] ? (pwm[p] >= 128) : latch[p];
  else if (p == 2) lvl = 1;
  else lvl = (mode_[p] == INPUT_PULLUP) ? 1 : 0;
  reg[p] = lvl;
}
volatile uint8_t *simPinRegister(uint8_t pin) { updateReg(pin); return &reg[pin]; }

void pinMode(uint8_t p, uint8_t m) { mode_[p] = m; fprintf(stderr, "PINMODE %u %u\n", p, m); }
void digitalWrite(uint8_t p, uint8_t v) { latch[p] = v; pwm[p] = 0; fprintf(stderr, "WRITE %u %u\n", p, v); }
int digitalRead(uint8_t p) { updateReg(p); return reg[p]; }
void analogWrite(uint8_t p, int v) { pwm[p] = (uint8_t)v; latch[p] = v ? 1 : 0; fprintf(stderr, "PWM %u %d\n", p, v); }
// Channel n: a ramp of 1 count per ms, offset by n*100 (so capture samples are easy to verify).
unsigned long simAdcClockUs = 0;
int analogRead(uint8_t p) {
  unsigned long ms = simAdcClockUs ? simAdcClockUs / 1000 : millis();
  return (int)((ms + (p - 14) * 100) % 1024);
}
unsigned long micros() {
  struct timeval t; gettimeofday(&t, 0);
  return (unsigned long)((t.tv_sec - t0.tv_sec) * 1000000UL + (t.tv_usec - t0.tv_usec));
}
unsigned long millis() {
  struct timeval t; gettimeofday(&t, 0);
  return (t.tv_sec - t0.tv_sec) * 1000UL + (t.tv_usec - t0.tv_usec) / 1000;
}

SimSerial Serial;
static int peeked = -1;
void SimSerial::begin(unsigned long) { fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK); }
int SimSerial::available() {
  if (peeked >= 0) return 1;
  unsigned char c; ssize_t n = ::read(0, &c, 1);
  if (n == 1) { peeked = c; return 1; }
  if (n == 0) _exit(0);              // stdin closed: host went away
  return 0;
}
int SimSerial::read() { if (peeked < 0 && !available()) return -1; int c = peeked; peeked = -1; return c; }
size_t SimSerial::write(uint8_t b) { fwrite(&b, 1, 1, stdout); fflush(stdout); return 1; }
size_t SimSerial::write(const uint8_t *b, size_t n) { fwrite(b, 1, n, stdout); fflush(stdout); return n; }

void setup();
void loop();
int main() {
  gettimeofday(&t0, 0);
  setup();
  for (;;) { loop(); usleep(100); }
}
