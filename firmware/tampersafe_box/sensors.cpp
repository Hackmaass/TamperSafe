#include "sensors.h"
#include "pins.h"

void sensorsInit() {
  pinMode(PIN_IR_LID, INPUT);
}

bool lidClosed() {
  return digitalRead(PIN_IR_LID) == LOW;
}
