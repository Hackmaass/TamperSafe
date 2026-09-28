#pragma once
// TamperSafe box -- GPIOs. Single source for firmware; docs/HARDWARE.md §2 is
// the human-readable copy. Every value here was confirmed on the physical box.

// --- IR lid sensor (FC-51), digital OUT: LOW = reflection = lid closed ------
#define PIN_IR_LID 15 // CH15 (P1 pin 10)

// --- GPS (u-blox NEO-6M), UART1, listen-only --------------------------------
#define PIN_GPS_RX 11 // CH11 (module TX -> here)

// --- RFID (MFRC522) on the extension board's RFID socket (SPI) --------------
// Found by scanning the socket's five IO lines (GPIO 15/16/17/18/3) for the
// mapping at which the chip answers. RST is deliberately NOT used: the socket
// routes it to GPIO15, which is the IR sensor's pin -- leave the RC522's RST
// wire unplugged (see HARDWARE.md §2).
#define PIN_RFID_SS   3
#define PIN_RFID_SCK  18
#define PIN_RFID_MOSI 17
#define PIN_RFID_MISO 16

// --- Fixed addresses on the shared I2C bus (SDA=8, SCL=9, set by nr.begin()) -
#define I2C_ADDR_STM32   0x08
#define I2C_ADDR_OLED    0x3C
#define I2C_ADDR_MPU6050 0x68
