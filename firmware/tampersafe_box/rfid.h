#pragma once
#include <Arduino.h>

// Package binding via the RC522 reader. Evidence only: a missing or changed tag
// raises the PACKAGE_MISMATCH alert (code 16). It never changes box state and
// never causes a tamper or a refund.

bool rfidInit();

// At seal: remember the tag on the reader. Returns false if no tag is present
// (the box then seals without package monitoring).
bool rfidBind();

// While SEALED, call about once a second. Raises PACKAGE_MISMATCH once per
// seal after 3 consecutive polls with the tag absent or a different one.
void rfidWatch();

// Forget the bound tag (unlock / reset / boot).
void rfidUnbind();

// True while a tag is bound (for status output).
bool rfidBound();
