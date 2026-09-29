#include "led.h"
#include "pins.h"

static uint8_t bgMask = LED_OFF;
static uint16_t bgBlinkMs = 0;
static uint8_t flashMask = LED_OFF;
static unsigned long flashUntil = 0;
static unsigned long flashStart = 0;
static uint16_t flashBlinkMs = 0;

static void write(uint8_t mask) {
  digitalWrite(PIN_LED_R, (mask & LED_R) ? HIGH : LOW);
  digitalWrite(PIN_LED_G, (mask & LED_G) ? HIGH : LOW);
  digitalWrite(PIN_LED_B, (mask & LED_B) ? HIGH : LOW);
}

void ledInit() {
  pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_LED_G, OUTPUT);
  pinMode(PIN_LED_B, OUTPUT);
  write(LED_OFF);
}

void ledBackground(uint8_t mask, uint16_t blinkMs) {
  bgMask = mask;
  bgBlinkMs = blinkMs;
}

void ledFlash(uint8_t mask, uint32_t ms, uint16_t blinkMs) {
  flashMask = mask;
  flashStart = millis();
  flashUntil = flashStart + ms;
  flashBlinkMs = blinkMs;
  write(mask); // light it now; ledTick keeps it up
}

void ledTick() {
  unsigned long now = millis();
  if (flashMask != LED_OFF && (long)(flashUntil - now) > 0) {
    if (flashBlinkMs == 0) write(flashMask);
    else write((((now - flashStart) / flashBlinkMs) & 1) ? LED_OFF : flashMask);
    return;
  }
  flashMask = LED_OFF;
  if (bgBlinkMs == 0) write(bgMask);
  else write(((now / bgBlinkMs) & 1) ? LED_OFF : bgMask);
}
