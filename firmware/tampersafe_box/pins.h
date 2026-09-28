#pragma once
// TamperSafe box -- GPIOs, copied verbatim from docs/HARDWARE.md §2.
//
// As of this pass, IR lid (CH15/GPIO15) and GPS (CH11/GPIO11) are CONFIRMED.
// Ultrasonic is DROPPED (no longer a pin to confirm). RFID is still TBD --
// HARDWARE.md §2 has no valid proposal for it (CH2/GPIO2 was proposed and
// rejected: GPIO2 is unavailable per CLAUDE.md). Per the neurick-firmware
// skill and CLAUDE.md's board discipline, a sketch may only use pins the
// team has confirmed. A TBD row blocks that pin's code.
//
// PINS_CONFIRMED still gates the whole file: leave it 0 until RFID gets a
// real, valid pin proposal in HARDWARE.md §2 AND sensors_stub.cpp's
// readGPS()/readRFID() are replaced with real drivers (readLidIR() already
// is one). Flipping it to 1 before that is caught at compile time (see
// sensors_stub.cpp's #error), so a half-stubbed box can't ship silently.
#define PINS_CONFIRMED 0

// --- GPS (u-blox NEO-6M), UART1 ---------------------------------------------
#define PIN_GPS_RX 11 // CH11 (module TX -> here)
#define PIN_GPS_TX -1 // Unused (listen-only)

// --- Ultrasonic (HC-SR04) ----------------------------------------------------
// DROPPED by team decision (28 Sept). Lid tamper is handled purely by the IR sensor.

// --- IR lid sensor (FC-51 / TCRT5000), digital OUT --------------------------
#define PIN_IR_LID 15 // CH15 (Header Pin 10 / GPIO 15)

// --- Onboard LDR (ADC1) -----------------------------------------------------
#define PIN_LDR_AO 4 // Extension board LDR on GPIO 4

// --- RFID (MFRC522, SPI) -----------------------------------------------------
// HARDWARE.md §2 has no proposed GPIO for any of these yet (all rows are
// bare "TBD", not even a guess) -- do not invent numbers, per the task brief.
// -1 is not a valid GPIO; it stands in as "no proposal exists at all".
#define PIN_RFID_SCK  -1 // TBD in HARDWARE.md §2 -- no proposal yet
#define PIN_RFID_MOSI -1 // TBD in HARDWARE.md §2 -- no proposal yet
#define PIN_RFID_MISO -1 // TBD in HARDWARE.md §2 -- no proposal yet
#define PIN_RFID_SDA  -1 // TBD in HARDWARE.md §2 -- no proposal yet (SS/CS)
#define PIN_RFID_RST  -1 // TBD in HARDWARE.md §2 -- no proposal yet

// --- Confirmed, NOT gated by PINS_CONFIRMED ---------------------------------
// These are fixed addresses on the shared I2C bus (SDA=8, SCL=9, set up once
// by nr.begin()) or STM32 channels via the Newrick library -- not header
// pins, so no HARDWARE.md §2 row applies and no TBD blocks them.
#define I2C_ADDR_STM32  0x08
#define I2C_ADDR_OLED   0x3C
#define I2C_ADDR_MPU6050 0x68
