#pragma once
#include <Arduino.h>

// Lid sensor. (The MPU6050 lives in mpu.h, the RFID reader in rfid.h.)

void sensorsInit();

// IR obstacle sensor: true while the lid reflects the beam (closed).
bool lidClosed();
