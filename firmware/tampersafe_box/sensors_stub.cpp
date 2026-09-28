#include "sensors_stub.h"
#include "pins.h"

// Ultrasonic and PIR motion were dropped by team decision (28 Sept) -- lid
// tamper detection is handled purely by the FC-51 IR sensor on CH15
// (GPIO 15), now confirmed, so readLidIR() below is a real driver, not a
// stub. GPS (pin confirmed) and RFID (pins still TBD -- HARDWARE.md §2)
// still return the documented FAKE sentinels. PINS_CONFIRMED must stay 0
// until those two are real too -- enforced below the same way the old
// guard enforced it for all four functions.
#if PINS_CONFIRMED
#error "PINS_CONFIRMED=1 but readGPS()/readRFID() in sensors_stub.cpp are still stub bodies. Replace them with real drivers first (readLidIR() is already real)."
#endif

int32_t readUltrasonicMm() {
  return 0; // DROPPED (28 Sept): no ultrasonic hardware -- not a stub, this sensor no longer exists
}

uint8_t readLidIR() {
  // Real driver: FC-51 IR obstacle module on CH15 (GPIO 15).
  // HIGH (1) = no reflection / lid open, LOW (0) = reflection / lid closed.
  static bool pinReady = false;
  if (!pinReady) {
    pinMode(PIN_IR_LID, INPUT);
    pinReady = true;
  }
  return digitalRead(PIN_IR_LID);
}

bool readGPS(int32_t *outLatE6, int32_t *outLonE6) {
  *outLatE6 = 0;
  *outLonE6 = 0;
  return false; // FAKE: always "no fix" -- no GPS driver yet (pin confirmed: CH11/GPIO11)
}

bool readRFID(char *outUid, size_t uidLen) {
  if (uidLen > 0) outUid[0] = '\0';
  return false; // FAKE: always "no tag" -- no RFID driver yet, and its pins are still TBD (HARDWARE.md §2)
}
