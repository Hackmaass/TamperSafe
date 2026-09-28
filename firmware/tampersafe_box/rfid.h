#pragma once
#include <Arduino.h>

// The buyer's delivery key: one enrolled RFID tag. At the doorstep the buyer
// signs "Confirm & Unlock" on-chain, then taps the key to open the latch. This
// proves the buyer is physically at the box; it never moves funds by itself.
// Any tag other than the enrolled one is "wrong". Nothing is written to a tag.

enum class Tag : uint8_t { None, Key, Other };

bool rfidInit();

// Call about 4 times a second. Returns a result ONCE per presentation of a tag
// (on the moment it arrives), and only after its UID was read successfully: a
// failed read is never reported as "wrong". With enroll = true, the first tag
// read is stored as the delivery key instead (and reported as Key).
Tag rfidScan(bool enroll = false);

bool rfidHasKey();
