#pragma once
#include <Arduino.h>

// Lid and GPS drivers. (The MPU6050 lives in mpu.h, the RFID reader in rfid.h.)

void sensorsInit();

// IR obstacle sensor: true while the lid reflects the beam (closed).
bool lidClosed();

// Feeds the GPS UART into the NMEA parser. Call every loop(). Returns true and
// fills lat/lon (microdegrees) only while a fix is valid and under 5 s old.
bool gpsPoll(int32_t *outLatE6, int32_t *outLonE6);

// True once the GPS module has sent any NMEA at all (separates "no fix" from
// "module silent / unwired").
bool gpsHeard();
