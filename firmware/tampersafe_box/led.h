#pragma once
#include <Arduino.h>

// Extension-board RGB LED. Colours are a bitmask of the three channels.
enum : uint8_t { LED_OFF = 0, LED_R = 1, LED_G = 2, LED_B = 4, LED_CYAN = LED_G | LED_B, LED_MAGENTA = LED_R | LED_B };

void ledInit();

// Steady background pattern. blinkMs = 0 for solid, otherwise the on/off
// half-period. A flash overrides it while active.
void ledBackground(uint8_t mask, uint16_t blinkMs = 0);

// Timed override, e.g. the result of an RFID scan. blinkMs = 0 is solid; otherwise
// the colour blinks with that on/off half-period (a fast blink is the "beep").
void ledFlash(uint8_t mask, uint32_t ms, uint16_t blinkMs = 0);

// Call every loop(): applies the current pattern to the pins.
void ledTick();
