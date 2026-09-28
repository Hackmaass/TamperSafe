#pragma once
#include <Arduino.h>

// Sensor accessors for the box. Gated behind PINS_CONFIRMED (pins.h) -- see
// sensors_stub.cpp for why flipping that flag without replacing the
// remaining stub functions is a compile error, not a silent no-op.
//
// readLidIR() is a REAL driver (IR pin confirmed on CH15/GPIO15, ultrasonic
// dropped by team decision 28 Sept). The rest are still stubs, gated behind
// PINS_CONFIRMED, and return sentinels deliberately NOT a plausible real
// reading so a caller that forgets to gate its use can't mistake a stub for
// data:
//   - readUltrasonicMm(): 0 (sensor dropped -- no ultrasonic hardware exists)
//   - readGPS(): always returns false ("no fix"), coordinates 0,0
//   - readRFID(): always returns false ("no tag"), empty UID (pins still TBD)

int32_t readUltrasonicMm();
uint8_t readLidIR();
bool readGPS(int32_t *outLatE6, int32_t *outLonE6);
bool readRFID(char *outUid, size_t uidLen);
