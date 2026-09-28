// TamperSafe bring-up: find which extension-board LED pin is which colour, and
// whether the LED is active-high (common cathode) or active-low (common anode).
//
// Watch the LED. Loop of: 4 s dark, then Phase A (one pin driven HIGH at a time,
// the others LOW), 4 s dark, then Phase B (one pin driven LOW, the others HIGH).
// Each step lasts 2.5 s, in the order GPIO 5, 6, 7. Note the colour per step.
#include <Arduino.h>

static const int LED_PINS[3] = {5, 6, 7};

static void drive(int active, bool activeHigh) {
  for (int i = 0; i < 3; i++) {
    bool on = (LED_PINS[i] == active);
    digitalWrite(LED_PINS[i], on == activeHigh ? HIGH : LOW);
  }
}

static void dark(bool activeHigh) {
  for (int i = 0; i < 3; i++) digitalWrite(LED_PINS[i], activeHigh ? LOW : HIGH);
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  for (int i = 0; i < 3; i++) pinMode(LED_PINS[i], OUTPUT);
  Serial.println("LED test: watch the board LED");
}

void loop() {
  Serial.println("--- dark ---");
  dark(true);
  delay(4000);
  for (int i = 0; i < 3; i++) {
    Serial.printf("PHASE A (active-high): GPIO %d HIGH, others LOW\n", LED_PINS[i]);
    drive(LED_PINS[i], true);
    delay(2500);
  }
  Serial.println("--- dark ---");
  dark(true);
  delay(4000);
  for (int i = 0; i < 3; i++) {
    Serial.printf("PHASE B (active-low): GPIO %d LOW, others HIGH\n", LED_PINS[i]);
    drive(LED_PINS[i], false);
    delay(2500);
  }
}
