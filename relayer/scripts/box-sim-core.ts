// Pure state machine for the SIMULATED BOX (npm run box). No timers, no
// network, no terminal: the caller injects a clock, drives tick() every
// 50 ms, and drains `outbox` over HTTP (see box-sim-net.ts). That split is
// what lets test/box-sim.test.ts drive every rule deterministically.
//
// Behaviour follows docs/ARCHITECTURE.md §8 (box states, two-factor unlock,
// latch-before-report) and docs/HARDWARE.md §5 (thresholds). The hash chain
// is NOT reimplemented here: every event goes through src/protocol.ts, the
// same module the relayer verifies with and the firmware self-test matches.
import fs from "node:fs";
import path from "node:path";
import { buildCanon, computeHead, GENESIS_HEAD, type BoxState, type CanonicalEventFields, type DeviceEventType, type LockState } from "../src/protocol.js";
import type { WireEvent } from "../src/ingest/types.js";

// --- Shared codes (ARCHITECTURE.md §6) ------------------------------------
export const TAMPER = { LID_OPENED: 1, CONTENTS_DISTURBED: 2, POWER_INTERRUPTED: 3 } as const;
export const ALERT = { SHOCK: 10, TILT: 11, AUTH_FAILED: 17 } as const;

// --- Thresholds (HARDWARE.md §5) -------------------------------------------
export const SAMPLE_MS = 50; // IR lid + MPU at 20 Hz
export const LID_OPEN_SAMPLES = 4; // 4 x 50 ms = 200 ms
export const SHOCK_MG = 2500; // 2.5 g
export const SHOCK_RATE_MS = 10_000;
export const TILT_DEG = 60;
export const TILT_HOLD_MS = 3_000;
export const MIN_SEAL_BATT_MV = 10_500;
export const TELEMETRY_SEALED_MS = 2_000;
export const TELEMETRY_OTHER_MS = 10_000;
export const RING_CAPACITY = 128;
export const LED_FLASH_MS = 2_000;

export interface DeviceCommand {
  id: string;
  type: "SEAL" | "UNLOCK" | "RESET";
  order_id: number;
}

/** What survives a power cycle: exactly the NVS keys from §8 that matter to
 * the sim (baseline_mm is meaningless without the dropped ultrasonic). */
export interface PersistedState {
  version: 1;
  box_id: string;
  seq: number;
  head: string;
  state: BoxState;
  order_id: number;
  tamper_code: number;
  boot_count: number;
}

export interface Nvs {
  load(): PersistedState | null;
  save(s: PersistedState): void;
}

export class MemoryNvs implements Nvs {
  data: PersistedState | null = null;
  load(): PersistedState | null {
    return this.data ? { ...this.data } : null;
  }
  save(s: PersistedState): void {
    this.data = { ...s };
  }
}

/** JSON file stand-in for NVS. Written with write-temp-then-rename so a kill
 * mid-write can't leave half a file. A corrupt or foreign file is a hard
 * error, never a silent restart at seq 1 (use --fresh to start over). */
export class FileNvs implements Nvs {
  constructor(readonly file: string) {}

  load(): PersistedState | null {
    if (!fs.existsSync(this.file)) return null;
    let parsed: PersistedState;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as PersistedState;
    } catch (err) {
      throw new Error(`box-sim: state file ${this.file} is unreadable (${(err as Error).message}). Refusing to restart the chain silently; rerun with --fresh to re-provision from seq 1.`);
    }
    if (parsed.version !== 1 || !Number.isInteger(parsed.seq) || parsed.seq < 0 || !/^[0-9a-f]{64}$/.test(parsed.head)) {
      throw new Error(`box-sim: state file ${this.file} is not a valid box-sim state. Rerun with --fresh to re-provision from seq 1.`);
    }
    return parsed;
  }

  save(s: PersistedState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8");
    try {
      fs.renameSync(tmp, this.file);
    } catch {
      // Windows can refuse a rename over a file another process has open
      // (antivirus, an editor). Fall back to a direct write.
      fs.writeFileSync(this.file, JSON.stringify(s, null, 2), "utf8");
      fs.rmSync(tmp, { force: true });
    }
  }
}

/** The physical world around the box. It survives a power cycle (the lid
 * doesn't close itself because the board rebooted). */
export interface World {
  lidClosed: boolean;
  battMv: number;
  shockPending: boolean;
  tiltUntil: number; // clock ms; tilted while now < tiltUntil
}

export type LedColor = "off" | "blue" | "green" | "red" | "red-blink";

export interface NoteEntry {
  at: number;
  level: "info" | "warn" | "error";
  text: string;
}

export interface BoxCoreOptions {
  boxId: string;
  nvs: Nvs;
  clock?: () => number; // ms
  random?: () => number; // [0,1), for sensor noise
  onEvent?: (e: WireEvent, urgent: boolean) => void;
  onNote?: (n: NoteEntry) => void;
}

const URGENT: ReadonlySet<DeviceEventType> = new Set(["BOOT", "SEALED", "SEAL_FAILED", "TAMPER", "ALERT", "UNLOCKED", "RESET_DONE"]);

export class BoxCore {
  readonly boxId: string;
  private readonly nvs: Nvs;
  private readonly clock: () => number;
  private readonly random: () => number;

  // Persisted (NVS)
  seq = 0;
  head = GENESIS_HEAD;
  state: BoxState = "BOOT";
  orderId = 0;
  tamperCode = 0;
  bootCount = 0;

  // RAM only: lost on power cycle
  lock: LockState = "U";
  armedCmdId: string | null = null;
  outbox: WireEvent[] = [];
  droppedFromRing = 0;
  /** Set when an event the firmware POSTs immediately (TAMPER, SEALED,
   * UNLOCKED, ...) was queued; the network side clears it when it sends. */
  urgentPending = false;
  /** Bumped on every boot so a network response that was in flight across a
   * power cycle can't deliver its command into the rebooted box. */
  generation = 0;
  private lastAckedCmdId: string | null = null;
  private lidOpenCount = 0;
  private lastShockAlertAt = -Infinity;
  private tiltSince: number | null = null;
  private tiltAlerted = false;
  private lastTelemetryAt = 0;
  private flash: { color: "green" | "red"; until: number } | null = null;
  accelMg = 1000;
  tiltDeg = 0;

  readonly world: World = { lidClosed: true, battMv: 11_700, shockPending: false, tiltUntil: 0 };
  private battDrainAnchor: number;

  constructor(private readonly opts: BoxCoreOptions) {
    this.boxId = opts.boxId;
    this.nvs = opts.nvs;
    this.clock = opts.clock ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    this.battDrainAnchor = this.clock();
  }

  get armed(): boolean {
    return this.armedCmdId !== null;
  }

  // --- persistence ---------------------------------------------------------
  private persist(): void {
    this.nvs.save({
      version: 1,
      box_id: this.boxId,
      seq: this.seq,
      head: this.head,
      state: this.state,
      order_id: this.orderId,
      tamper_code: this.tamperCode,
      boot_count: this.bootCount,
    });
  }

  private note(text: string, level: NoteEntry["level"] = "info"): void {
    this.opts.onNote?.({ at: this.clock(), level, text });
  }

  // --- events --------------------------------------------------------------
  /** Builds the next chained event, writes seq/head/state to NVS, THEN queues
   * it (latch before report, §8). Returns the wire event. */
  private emit(type: DeviceEventType, code = 0, cmdId = ""): WireEvent {
    const seq = this.seq + 1;
    const fields: CanonicalEventFields = {
      box_id: this.boxId,
      seq,
      ts: Math.floor(this.clock() / 1000),
      type,
      state: this.state,
      order_id: this.orderId,
      lat_e6: 0, // the box has no GPS fix indoors; the dashboard's route is SIMULATED (Invariant 4)
      lon_e6: 0,
      fix: 0,
      dist_mm: 0, // ultrasonic dropped (HARDWARE.md)
      lid: this.world.lidClosed ? 1 : 0,
      accel_mg: this.accelMg,
      tilt_deg: this.tiltDeg,
      lock: this.lock,
      batt_mv: this.battMv(),
      code,
      cmd_id: cmdId,
    };
    const head = computeHead(this.head, buildCanon(fields));
    this.seq = seq;
    this.head = head;
    this.persist();
    const { box_id: _b, ...wire } = fields;
    const event: WireEvent = { ...wire, head };
    this.outbox.push(event);
    if (this.outbox.length > RING_CAPACITY) {
      // Ring buffer full: drop the oldest, exactly like the firmware. The
      // relayer will see a seq gap and raise LOG_GAP (§8, §10).
      this.outbox.shift();
      this.droppedFromRing += 1;
    }
    if (type === "TELEMETRY") this.lastTelemetryAt = this.clock();
    if (URGENT.has(type)) this.urgentPending = true;
    this.opts.onEvent?.(event, URGENT.has(type));
    return event;
  }

  /** Removes every buffered event with seq <= ackSeq (the relayer's ack_seq). */
  ackThrough(ackSeq: number): void {
    this.outbox = this.outbox.filter((e) => e.seq > ackSeq);
  }

  // --- boot ----------------------------------------------------------------
  /** Power-on: load NVS, apply the §8 reboot mapping, emit BOOT (and TAMPER
   * again if the box comes up TAMPERED against a real order). */
  boot(): WireEvent[] {
    const saved = this.nvs.load();
    if (saved && saved.box_id !== this.boxId) {
      throw new Error(`box-sim: state file belongs to ${saved.box_id}, not ${this.boxId}. Use a different --state file or --fresh.`);
    }
    this.generation += 1;
    this.seq = saved?.seq ?? 0;
    this.head = saved?.head ?? GENESIS_HEAD;
    this.orderId = saved?.order_id ?? 0;
    this.tamperCode = saved?.tamper_code ?? 0;
    this.bootCount = (saved?.boot_count ?? 0) + 1;
    const prev: BoxState = saved?.state ?? "IDLE";

    // RAM is gone after a reboot.
    this.armedCmdId = null;
    this.outbox = [];
    this.lastAckedCmdId = null;
    this.lidOpenCount = 0;
    this.lastShockAlertAt = -Infinity;
    this.tiltSince = null;
    this.tiltAlerted = false;
    this.flash = null;
    this.lastTelemetryAt = this.clock();

    let reemitTamper = false;
    if (prev === "SEALED") {
      // Power lost while sealed IS tamper (Invariant 3). Latch first.
      this.state = "TAMPERED";
      this.tamperCode = TAMPER.POWER_INTERRUPTED;
      this.lock = "L";
      reemitTamper = this.orderId !== 0;
      this.note("booted from SEALED: power was interrupted, latching TAMPER POWER_INTERRUPTED", "warn");
    } else if (prev === "TAMPERED") {
      this.state = "TAMPERED";
      this.lock = "L";
      reemitTamper = this.orderId !== 0;
      this.note(`booted TAMPERED (code ${this.tamperCode}): latch persists, re-reporting`, "warn");
    } else {
      // IDLE, OPEN_AUTHORIZED, ARMING, BOOT -> IDLE
      this.state = "IDLE";
      this.orderId = 0;
      this.tamperCode = 0;
      this.lock = "U";
    }
    this.persist();

    const out = [this.emit("BOOT")];
    if (reemitTamper) out.push(this.emit("TAMPER", this.tamperCode));
    return out;
  }

  /** Simulated power cycle: RAM lost (buffer, armed flag), NVS kept. */
  powerCycle(): WireEvent[] {
    this.note(`power cycle (${this.outbox.length} unsent event(s) in RAM are lost)`, this.outbox.length ? "warn" : "info");
    return this.boot();
  }

  // --- sensors -------------------------------------------------------------
  private battMv(): number {
    // ~1 mV per 30 s of slow drain on top of whatever the world says.
    const drain = Math.floor((this.clock() - this.battDrainAnchor) / 30_000);
    return Math.max(0, this.world.battMv - drain);
  }

  /** One 20 Hz sample: lid, MPU, telemetry schedule. Call every SAMPLE_MS. */
  tick(): WireEvent[] {
    const out: WireEvent[] = [];
    const now = this.clock();
    if (this.state === "BOOT") return out;

    // IR lid: 4 consecutive open samples while SEALED latches LID_OPENED.
    if (this.state === "SEALED" && !this.world.lidClosed) {
      this.lidOpenCount += 1;
      if (this.lidOpenCount >= LID_OPEN_SAMPLES) out.push(...this.latchTamper(TAMPER.LID_OPENED));
    } else {
      this.lidOpenCount = 0;
    }

    // MPU6050: accel magnitude around 1 g with a little noise.
    const noise = Math.round((this.random() - 0.5) * 30);
    if (this.world.shockPending) {
      this.world.shockPending = false;
      this.accelMg = 3100 + Math.round(this.random() * 400);
    } else {
      this.accelMg = 1000 + noise;
    }
    const tilted = now < this.world.tiltUntil;
    this.tiltDeg = tilted ? 72 + Math.round(this.random() * 6) : Math.round(this.random() * 2);

    if (this.accelMg > SHOCK_MG && now - this.lastShockAlertAt >= SHOCK_RATE_MS) {
      this.lastShockAlertAt = now;
      out.push(this.emit("ALERT", ALERT.SHOCK));
    }
    if (this.tiltDeg > TILT_DEG) {
      this.tiltSince ??= now;
      if (!this.tiltAlerted && now - this.tiltSince >= TILT_HOLD_MS) {
        this.tiltAlerted = true;
        out.push(this.emit("ALERT", ALERT.TILT));
      }
    } else {
      this.tiltSince = null;
      this.tiltAlerted = false;
    }

    const every = this.state === "SEALED" ? TELEMETRY_SEALED_MS : TELEMETRY_OTHER_MS;
    if (now - this.lastTelemetryAt >= every) out.push(this.emit("TELEMETRY"));
    return out;
  }

  private latchTamper(code: number): WireEvent[] {
    this.state = "TAMPERED";
    this.tamperCode = code;
    this.lock = "L"; // servo stays locked until RESET
    this.armedCmdId = null;
    this.lidOpenCount = 0;
    this.persist(); // latch first...
    this.note(`TAMPER latched: code ${code}`, "error");
    return [this.emit("TAMPER", code)]; // ...then report
  }

  // --- commands (from POST /api/device/events responses) -------------------
  handleCommand(cmd: DeviceCommand): WireEvent[] {
    if (cmd.id === this.lastAckedCmdId) return []; // our ack is already queued or sent
    switch (cmd.type) {
      case "SEAL":
        return this.onSeal(cmd);
      case "UNLOCK":
        return this.onUnlock(cmd);
      case "RESET":
        return this.onReset(cmd);
      default:
        return [];
    }
  }

  private ack(type: DeviceEventType, cmdId: string): WireEvent {
    this.lastAckedCmdId = cmdId;
    return this.emit(type, 0, cmdId);
  }

  private onSeal(cmd: DeviceCommand): WireEvent[] {
    if (this.state !== "IDLE") return [];
    this.state = "ARMING";
    this.persist();
    const batt = this.battMv();
    if (!this.world.lidClosed || batt < MIN_SEAL_BATT_MV) {
      const why = !this.world.lidClosed ? "lid is open" : `battery ${(batt / 1000).toFixed(2)} V < ${MIN_SEAL_BATT_MV / 1000} V`;
      this.note(`SEAL refused: ${why}`, "warn");
      this.state = "IDLE";
      this.orderId = 0;
      this.lock = "U";
      return [this.ack("SEAL_FAILED", cmd.id)];
    }
    this.lock = "L";
    this.orderId = cmd.order_id;
    this.tamperCode = 0;
    this.state = "SEALED";
    this.lidOpenCount = 0;
    this.note(`sealed for order #${cmd.order_id}`);
    return [this.ack("SEALED", cmd.id)];
  }

  private onUnlock(cmd: DeviceCommand): WireEvent[] {
    // Two-factor: UNLOCK only ARMS a sealed box for its own order. No event,
    // no ack; the relayer keeps resending, which is idempotent here.
    if (this.state !== "SEALED" || cmd.order_id !== this.orderId) return [];
    if (this.armedCmdId === null) this.note(`UNLOCK received: armed, waiting for the delivery key (${cmd.id})`);
    this.armedCmdId = cmd.id;
    return [];
  }

  private onReset(cmd: DeviceCommand): WireEvent[] {
    if (this.state !== "TAMPERED" && this.state !== "OPEN_AUTHORIZED" && this.state !== "IDLE") return [];
    this.state = "IDLE";
    this.orderId = 0;
    this.tamperCode = 0;
    this.lock = "U";
    this.armedCmdId = null;
    this.note("RESET: back to IDLE, latch cleared");
    return [this.ack("RESET_DONE", cmd.id)];
  }

  // --- physical actions ----------------------------------------------------
  liftLid(): void {
    this.world.lidClosed = false;
    this.note("lid lifted");
  }

  closeLid(): void {
    this.world.lidClosed = true;
    this.note("lid closed");
  }

  shock(): void {
    this.world.shockPending = true;
    this.note("shock applied");
  }

  tilt(durationMs = 4_000): void {
    this.world.tiltUntil = this.clock() + durationMs;
    this.note(`tilted ~75 deg for ${durationMs / 1000} s`);
  }

  setBatteryMv(mv: number): void {
    this.world.battMv = mv;
    this.battDrainAnchor = this.clock();
    this.note(`battery set to ${(mv / 1000).toFixed(2)} V`);
  }

  /** A tag tap on the reader. RIGHT = the enrolled delivery key. */
  tapTag(kind: "RIGHT" | "WRONG"): WireEvent[] {
    const now = this.clock();
    if (this.state === "SEALED") {
      if (kind === "WRONG") {
        this.flash = { color: "red", until: now + LED_FLASH_MS };
        this.note("wrong tag on a sealed box: stays locked, AUTH_FAILED logged", "warn");
        return [this.emit("ALERT", ALERT.AUTH_FAILED)];
      }
      if (this.armedCmdId === null) {
        this.note("delivery key tapped but the box is not armed (no requestUnlock yet): nothing opens");
        return [];
      }
      const cmdId = this.armedCmdId;
      this.armedCmdId = null;
      this.lock = "U";
      this.state = "OPEN_AUTHORIZED";
      this.flash = { color: "green", until: now + LED_FLASH_MS };
      this.note("delivery key accepted: latch open");
      return [this.ack("UNLOCKED", cmdId)];
    }
    // IDLE / OPEN_AUTHORIZED / TAMPERED: local LED feedback only.
    this.flash = { color: kind === "RIGHT" ? "green" : "red", until: now + LED_FLASH_MS };
    this.note(`${kind === "RIGHT" ? "delivery key" : "wrong tag"} tapped in ${this.state}: LED feedback only`);
    return [];
  }

  /** LED semantics from HARDWARE.md: a tap flash wins for 2 s, then a latched
   * tamper blinks red, then armed pulses blue, else off. */
  led(): LedColor {
    const now = this.clock();
    if (this.flash && now < this.flash.until) return this.flash.color;
    if (this.state === "TAMPERED") return "red-blink";
    if (this.armed) return "blue";
    return "off";
  }

  /** Sends a TELEMETRY event right now (the [n] key): the relayer only
   * hands out commands in POST responses, so this is a manual poll. */
  telemetryNow(): WireEvent[] {
    if (this.state === "BOOT") return [];
    return [this.emit("TELEMETRY")];
  }

  /** Battery as the sensors currently read it (mV). */
  batteryMv(): number {
    return this.battMv();
  }
}
