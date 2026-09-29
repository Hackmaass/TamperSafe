#pragma once
// TamperSafe box -- GPIOs. Single source for firmware; docs/HARDWARE.md §2 is
// the human-readable copy. Every value here was confirmed on the physical box.

// --- IR lid sensor (FC-51), digital OUT: LOW = reflection = lid closed ------
// Plugged into the extension-board connector printed IO11 (GPIO 11); the board's
// printed IO numbers are the GPIO numbers. That was the GPS connector, so the GPS
// is dropped for the demo (it never produced data and is evidence only).
#define PIN_IR_LID 11

// --- RFID (MFRC522) on the extension board's RFID socket (SPI) --------------
// Found by scanning the socket's five IO lines (GPIO 15/16/17/18/3) for the
// mapping at which the chip answers.
#define PIN_RFID_SS   3
#define PIN_RFID_SCK  18
#define PIN_RFID_MOSI 17
#define PIN_RFID_MISO 16
#define PIN_RFID_RST  15

// --- Extension-board RGB LED, active-high (found with bringup/led_test) -------
#define PIN_LED_R 7
#define PIN_LED_G 6
#define PIN_LED_B 5

// --- Fixed addresses on the shared I2C bus (SDA=8, SCL=9, set by nr.begin()) -
#define I2C_ADDR_STM32   0x08
#define I2C_ADDR_OLED    0x3C
#define I2C_ADDR_MPU6050 0x68
