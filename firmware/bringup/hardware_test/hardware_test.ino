#include <Newrick.h>
#include <Wire.h>

Newrick nr;

// PIR motion (was CH14) dropped by team decision (28 Sept) -- see CLAUDE.md.
// Motion/shock is handled by the onboard MPU6050 instead.
const int PIN_INFRARED = 15; // CH15 (IR Obstacle / Lid)

// Let's test both CH11 pins for GPS TX
HardwareSerial GPS1(1);
HardwareSerial GPS2(2);

void setup() {
  Serial.begin(115200);
  delay(1000);

  nr.begin(); // Starts I2C (SDA=8, SCL=9)

  pinMode(PIN_INFRARED, INPUT);
  pinMode(10, INPUT);

  // Listen on GPIO 11 and GPIO 12 at 9600 baud
  GPS1.begin(9600, SERIAL_8N1, 11, -1);
  GPS2.begin(9600, SERIAL_8N1, 12, -1);

  Serial.println("\n--- TAMPERSAFE DIAGNOSTIC: INTERACTIVE SENSOR CHECK ---");
}

void loop() {
  if (nr.updateSensors()) {
    Serial.printf("[BATT: %4.1fV] ", nr.batteryVolts);
  } else {
    Serial.print("[BATT: N/A] ");
  }

  int ir = digitalRead(PIN_INFRARED);
  Serial.printf("| IR_Lid(15): %d ", ir);

  // GPS check
  if (GPS1.available()) {
    String nmea = GPS1.readStringUntil('\n');
    Serial.printf("| GPS on Pin11: %s ", nmea.substring(0, 25).c_str());
  } else if (GPS2.available()) {
    String nmea = GPS2.readStringUntil('\n');
    Serial.printf("| GPS on Pin12: %s ", nmea.substring(0, 25).c_str());
  } else {
    Serial.print("| GPS: waiting ");
  }

  // LDR candidate: A4
  Serial.printf("| LDR_A4: %d\n", analogRead(4));

  delay(300);
}
