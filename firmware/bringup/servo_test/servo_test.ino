#include <Newrick.h>

Newrick neurick;

int currentAngle = 90;
int lockAngle    = -1;
int unlockAngle  = -1;

void moveServo(int angle) {
  if (angle < 0) angle = 0;
  if (angle > 180) angle = 180;
  currentAngle = angle;
  neurick.servo((uint8_t)angle, (uint8_t)angle, (uint8_t)angle);
  Serial.printf("SERVO -> %d deg\n", currentAngle);
}

void setup() {
  Serial.begin(115200);

  // Wait for USB CDC connection (critical for ESP32-S3 native USB)
  unsigned long waitStart = millis();
  while (!Serial && millis() - waitStart < 3000) {
    delay(10);
  }

  neurick.begin();
  delay(2000);

  Serial.println("=== SERVO CALIBRATOR READY ===");
  Serial.println("Send: 0-180 (angle), +N/-N (offset), L (lock), U (unlock), T (test), D (demo)");
  Serial.println("==============================");

  moveServo(90);

  // Quick boot sweep to prove servo is alive
  Serial.println("[BOOT] Quick sweep: 45 -> 135 -> 90");
  moveServo(45);
  delay(500);
  moveServo(135);
  delay(500);
  moveServo(90);
  delay(500);
  Serial.println("[BOOT] Sweep done. Waiting for commands...");
}

void loop() {
  if (Serial.available() > 0) {
    String input = Serial.readStringUntil('\n');
    input.trim();

    if (input.length() == 0) return;

    Serial.printf("[RX] Got: '%s'\n", input.c_str());

    // Direct angle number
    bool isNum = true;
    for (unsigned int i = 0; i < input.length(); i++) {
      if (!isDigit(input.charAt(i))) { isNum = false; break; }
    }
    if (isNum && input.length() > 0) {
      moveServo(input.toInt());
      return;
    }

    // Relative offset: +5, -10, etc.
    if (input.charAt(0) == '+' || input.charAt(0) == '-') {
      int delta = input.toInt();
      if (delta != 0) {
        moveServo(currentAngle + delta);
        return;
      }
    }

    char cmd = toupper(input.charAt(0));

    switch (cmd) {
      case 'W': moveServo(currentAngle + 1); break;
      case 'S': moveServo(currentAngle - 1); break;
      case 'D':
        if (input.equalsIgnoreCase("demo") || input.equalsIgnoreCase("d")) {
          Serial.println("--- AUTO SWEEP 0 -> 180 -> 0 ---");
          for (int a = 0; a <= 180; a += 15) { moveServo(a); delay(600); }
          for (int a = 180; a >= 0; a -= 15) { moveServo(a); delay(600); }
          moveServo(90);
          Serial.println("--- SWEEP DONE ---");
        } else {
          moveServo(currentAngle + 5);
        }
        break;
      case 'A': moveServo(currentAngle - 5); break;
      case 'L':
        lockAngle = currentAngle;
        Serial.printf("*** LOCK_ANGLE = %d ***\n", lockAngle);
        break;
      case 'U':
        unlockAngle = currentAngle;
        Serial.printf("*** UNLOCK_ANGLE = %d ***\n", unlockAngle);
        break;
      case 'T':
        if (lockAngle >= 0 && unlockAngle >= 0) {
          Serial.println("--- TEST: LOCK -> UNLOCK ---");
          moveServo(lockAngle);
          delay(2000);
          moveServo(unlockAngle);
          delay(2000);
          Serial.println("--- TEST DONE ---");
        } else {
          Serial.println("Set L and U first!");
        }
        break;
      case '?':
        Serial.println("Send: 0-180 (angle), +N/-N, W/S (+/-1), A/D (+/-5), L, U, T, demo");
        break;
      default:
        Serial.printf("Unknown: '%s'. Send ? for help.\n", input.c_str());
        break;
    }
  }

  delay(20);
}
