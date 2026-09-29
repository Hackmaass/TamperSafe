#include <Newrick.h>

Newrick neurick;

int currentAngle = 90;
int lockAngle    = -1;
int unlockAngle  = -1;

void moveServo(int angle) {
  if (angle < 0) angle = 0;
  if (angle > 180) angle = 180;
  currentAngle = angle;
  // Send to all three channels so whichever physical port is used (S1, S2, or S4), it moves!
  neurick.servo((uint8_t)angle, (uint8_t)angle, (uint8_t)angle);
  Serial.println();
  Serial.println("=========================================");
  Serial.printf("  >>> SERVO MOVED TO: %d DEGREES <<<\n", currentAngle);
  Serial.println("=========================================");
}

void runAutoSweep() {
  Serial.println("\n-------------------------------------------");
  Serial.println(">>> RUNNING AUTO-CALIBRATION SWEEP <<<");
  Serial.println("Watch your box latch at each position!");
  Serial.println("-------------------------------------------");
  
  const int angles[] = { 0, 30, 45, 60, 90, 120, 135, 150, 180 };
  for (int i = 0; i < 9; i++) {
    int a = angles[i];
    Serial.printf("\n[STEP %d/9] Testing Angle: %d deg ... (holding for 3s)\n", i + 1, a);
    moveServo(a);
    delay(3000);
  }
  
  Serial.println("\n--- Sweep complete! Returning to 90 deg ---");
  moveServo(90);
}

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(100); // 100ms timeout for fast serial response

  // Wait for USB CDC connection (ESP32-S3 native USB)
  unsigned long waitStart = millis();
  while (!Serial && millis() - waitStart < 3000) {
    delay(10);
  }

  neurick.begin();
  delay(1000);

  Serial.println("\n\n================================================");
  Serial.println("       TAMPERSAFE SERVO CALIBRATOR");
  Serial.println("================================================");
  Serial.println("HOW TO CONTROL THE SERVO:");
  Serial.println("  1. Type ANY angle (0 to 180) & press Enter");
  Serial.println("     Examples: 0, 45, 90, 120, 160, 180");
  Serial.println("  2. Type 'auto' or 'd' for an automatic sweep");
  Serial.println("  3. Type '+' or '-' to nudge by 5 degrees");
  Serial.println("  4. Or CLICK THE BUTTON on the board for +15 deg");
  Serial.println("================================================");

  // Quick boot sweep so you see the motor move immediately
  Serial.println("\n[BOOT] Running self-test sweep (45 -> 135 -> 90)...");
  moveServo(45);
  delay(600);
  moveServo(135);
  delay(600);
  moveServo(90);
  delay(600);
  Serial.println("[BOOT] Ready! Type an angle (e.g. 120) and hit Enter:\n");
}

void loop() {
  // Check for Serial Monitor Input
  if (Serial.available() > 0) {
    String input = Serial.readStringUntil('\n');
    input.trim();

    if (input.length() > 0) {
      Serial.printf("[INPUT RECEIVED] \"%s\"\n", input.c_str());

      // 1. Auto sweep mode
      if (input.equalsIgnoreCase("auto") || input.equalsIgnoreCase("sweep") || input.equalsIgnoreCase("d")) {
        runAutoSweep();
        return;
      }

      // 2. Direct numeric angle (e.g. 0, 45, 90, 120, 180)
      if (isDigit(input.charAt(0))) {
        int target = input.toInt();
        if (target >= 0 && target <= 180) {
          moveServo(target);
        } else {
          Serial.printf("Angle %d is out of range! Please enter 0 - 180.\n", target);
        }
        return;
      }

      // 3. Relative offsets like +5, -10
      if ((input.charAt(0) == '+' || input.charAt(0) == '-') && input.length() > 1 && isDigit(input.charAt(1))) {
        int delta = input.toInt();
        moveServo(currentAngle + delta);
        return;
      }

      // 4. Single-letter commands
      char cmd = toupper(input.charAt(0));
      switch (cmd) {
        case '+':
        case 'W':
          moveServo(currentAngle + 5);
          break;
        case '-':
        case 'S':
          moveServo(currentAngle - 5);
          break;
        case 'L':
          lockAngle = currentAngle;
          Serial.println("----------------------------------------");
          Serial.printf(">>> SAVED LOCK_ANGLE = %d <<<\n", lockAngle);
          Serial.println("----------------------------------------");
          break;
        case 'U':
          unlockAngle = currentAngle;
          Serial.println("----------------------------------------");
          Serial.printf(">>> SAVED UNLOCK_ANGLE = %d <<<\n", unlockAngle);
          Serial.println("----------------------------------------");
          break;
        case 'T':
          if (lockAngle >= 0 && unlockAngle >= 0) {
            Serial.println("\n>>> TESTING LOCK & UNLOCK CYCLE <<<");
            Serial.printf("Locking at %d deg...\n", lockAngle);
            moveServo(lockAngle);
            delay(2500);
            Serial.printf("Unlocking at %d deg...\n", unlockAngle);
            moveServo(unlockAngle);
            delay(2500);
            Serial.println(">>> TEST COMPLETE <<<\n");
          } else {
            Serial.println("Set L (lock) and U (unlock) first!");
          }
          break;
        default:
          Serial.printf("Unrecognized input: '%s'. Enter a number 0-180 or 'auto'.\n", input.c_str());
          break;
      }
    }
  }

  // Poll onboard user button at safe 10 Hz (every 100ms)
  static unsigned long lastSensorPoll = 0;
  if (millis() - lastSensorPoll >= 100) {
    lastSensorPoll = millis();
    if (neurick.updateSensors()) {
      static int lastBtn = 0;
      int btn = neurick.buttonState;
      if (btn == 1 && lastBtn == 0) { // On button press
        int next = currentAngle + 15;
        if (next > 180) next = 0;
        Serial.printf("\n[BOARD BUTTON PRESSED] Stepping to %d deg\n", next);
        moveServo(next);
      }
      lastBtn = btn;
    }
  }

  delay(10);
}
