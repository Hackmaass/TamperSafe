#include <Newrick.h>

Newrick neurick;

#define PIN_IR_LID 15 // CH15 (FC-51 Infrared Lid Sensor)

int currentAngle = 90;
int lockAngle    = 170;
int unlockAngle  = 10;

void printStatus() {
  int ir = digitalRead(PIN_IR_LID);
  Serial.printf("--> CURRENT: %3d deg | [L]OCK: %3d deg | [U]NLOCK: %3d deg | Lid(CH15): %s\n",
                currentAngle, lockAngle, unlockAngle,
                (ir == 0 ? "CLOSED [OK]" : "OPEN   [!!]"));
}

void setServoAngle(int angle) {
  if (angle < 0)   angle = 0;
  if (angle > 180) angle = 180;
  currentAngle = angle;

  // Command all 3 servo channels (S1, S2, S4) so Servo 2 moves
  neurick.servo((uint8_t)currentAngle, (uint8_t)currentAngle, (uint8_t)currentAngle);

  printStatus();
}

void printBanner() {
  Serial.println("\n=======================================================");
  Serial.println("       TAMPERSAFE INTERACTIVE SERVO CALIBRATION        ");
  Serial.println("=======================================================");
  Serial.println("CONTROLS (Serial Monitor or Terminal):");
  Serial.println("  • UP / RIGHT Arrow or 'w' / '+' : Increase angle (+1 / +5 deg)");
  Serial.println("  • DOWN / LEFT Arrow or 's' / '-' : Decrease angle (-1 / -5 deg)");
  Serial.println("  • Enter any number 0 - 180        : Jump directly (e.g. 45, 120)");
  Serial.println("  • Press 'L'                       : MARK current angle as LOCK");
  Serial.println("  • Press 'U'                       : MARK current angle as UNLOCK");
  Serial.println("  • Press 'T'                       : TEST cycle (LOCK -> UNLOCK)");
  Serial.println("  • Press '?'                       : Show this menu again");
  Serial.println("=======================================================\n");
}

void printMarked() {
  Serial.println("\n***************************************************");
  Serial.printf(">>> SAVED CONFIGURATION <<<\n");
  Serial.printf("    LOCK_ANGLE   = %d deg\n", lockAngle);
  Serial.printf("    UNLOCK_ANGLE = %d deg\n", unlockAngle);
  Serial.println("***************************************************\n");
}

void runTestCycle() {
  Serial.println("\n--- RUNNING LATCH TEST CYCLE ---");
  Serial.printf("1. Moving to LOCK position (%d deg)...\n", lockAngle);
  setServoAngle(lockAngle);
  delay(2000);
  Serial.printf("2. Moving to UNLOCK position (%d deg)...\n", unlockAngle);
  setServoAngle(unlockAngle);
  delay(2000);
  Serial.println("--- TEST CYCLE FINISHED ---\n");
}

void setup() {
  Serial.begin(115200);

  // Exact clean startup sequence verified on hardware
  neurick.begin();
  delay(2000);

  pinMode(PIN_IR_LID, INPUT_PULLUP);

  printBanner();
  setServoAngle(90); // Center position
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();

    // Check for ANSI Escape Sequences (Arrow keys: \x1B [ A/B/C/D)
    if (c == 0x1B) {
      unsigned long start = millis();
      while (!Serial.available() && millis() - start < 50);
      if (Serial.available() && Serial.read() == '[') {
        start = millis();
        while (!Serial.available() && millis() - start < 50);
        if (Serial.available()) {
          char arrow = Serial.read();
          if (arrow == 'A') { // UP arrow: +1 deg
            setServoAngle(currentAngle + 1);
            return;
          } else if (arrow == 'B') { // DOWN arrow: -1 deg
            setServoAngle(currentAngle - 1);
            return;
          } else if (arrow == 'C') { // RIGHT arrow: +5 deg
            setServoAngle(currentAngle + 5);
            return;
          } else if (arrow == 'D') { // LEFT arrow: -5 deg
            setServoAngle(currentAngle - 5);
            return;
          }
        }
      }
      return;
    }

    // Process single-key shortcuts
    if (c == '+' || c == '=') {
      setServoAngle(currentAngle + 5);
    } else if (c == '-') {
      setServoAngle(currentAngle - 5);
    } else if (c == 'w' || c == 'W') {
      setServoAngle(currentAngle + 1);
    } else if (c == 's' || c == 'S') {
      setServoAngle(currentAngle - 1);
    } else if (c == 'd' || c == 'D') {
      setServoAngle(currentAngle + 5);
    } else if (c == 'a' || c == 'A') {
      setServoAngle(currentAngle - 5);
    } else if (c == 'l' || c == 'L') {
      lockAngle = currentAngle;
      printMarked();
    } else if (c == 'u' || c == 'U') {
      unlockAngle = currentAngle;
      printMarked();
    } else if (c == 't' || c == 'T') {
      runTestCycle();
    } else if (c == '?' || c == 'h' || c == 'H') {
      printBanner();
    } else if (c >= '0' && c <= '9') {
      // Read multi-digit number
      int val = c - '0';
      unsigned long start = millis();
      while (millis() - start < 100) {
        if (Serial.available()) {
          char next = Serial.peek();
          if (next >= '0' && next <= '9') {
            val = val * 10 + (Serial.read() - '0');
            start = millis();
          } else if (next == '\r' || next == '\n') {
            Serial.read();
            break;
          } else {
            break;
          }
        }
      }
      setServoAngle(val);
    }
  }

  // Monitor Lid IR sensor state changes live
  static int lastIrState = -1;
  int currentIr = digitalRead(PIN_IR_LID);
  if (currentIr != lastIrState) {
    lastIrState = currentIr;
    Serial.printf("[LID CHANGE] CH15 sensor changed to: %s\n",
                  (currentIr == 0 ? "CLOSED [OK]" : "OPEN   [!!]"));
  }

  delay(20);
}
