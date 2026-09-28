#include "sensors.h"
#include "pins.h"

#include <TinyGPSPlus.h>

static TinyGPSPlus gps;

void sensorsInit() {
  pinMode(PIN_IR_LID, INPUT_PULLUP);
  Serial1.begin(9600, SERIAL_8N1, PIN_GPS_RX, -1);
}

bool lidClosed() {
  return digitalRead(PIN_IR_LID) == LOW;
}

bool gpsPoll(int32_t *outLatE6, int32_t *outLonE6) {
  while (Serial1.available()) gps.encode(Serial1.read());
  if (!gps.location.isValid() || gps.location.age() >= 5000) return false;
  *outLatE6 = (int32_t)lround(gps.location.lat() * 1e6);
  *outLonE6 = (int32_t)lround(gps.location.lng() * 1e6);
  return true;
}

bool gpsHeard() {
  return gps.charsProcessed() > 0;
}
