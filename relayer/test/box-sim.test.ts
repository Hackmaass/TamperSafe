// Unit tests for the SIMULATED BOX (scripts/box-sim-*.ts). Every batch the
// box produces is fed through the relayer's REAL verifier (src/ingest/verify.ts),
// so these tests prove the wire format, the MAC and chain continuity against
// the code that will actually judge them, with no server and no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GENESIS_HEAD } from "../src/protocol.js";
import { verifyBatch } from "../src/ingest/verify.js";
import type { BoxIngestState, WireBatch } from "../src/ingest/types.js";
import { BoxCore, FileNvs, MemoryNvs, RING_CAPACITY, type DeviceCommand, type Nvs } from "../scripts/box-sim-core.js";
import { BoxNet, type FetchLike } from "../scripts/box-sim-net.js";
import { renderFrame, visibleLength, type UiSnapshot } from "../scripts/box-sim-ui.js";
import { resolveSecret } from "../scripts/box-sim.js";

const BOX = "TS-BOX-01";
const SECRET = "11".repeat(32);

function makeCore(nvs: Nvs = new MemoryNvs(), start = 1_790_000_000_000) {
  const clock = { now: start };
  let r = 0;
  const core = new BoxCore({ boxId: BOX, nvs, clock: () => clock.now, random: () => ((r = (r * 9301 + 49297) % 233280) / 233280) });
  const advance = (ms: number) => {
    // Step in 50 ms samples like the firmware loop.
    for (let t = 0; t < ms; t += 50) {
      clock.now += 50;
      core.tick();
    }
  };
  return { core, clock, advance, nvs };
}

const SEAL = (order = 7, id = "cmd-1"): DeviceCommand => ({ id, type: "SEAL", order_id: order });
const UNLOCK = (order = 7, id = "cmd-2"): DeviceCommand => ({ id, type: "UNLOCK", order_id: order });
const RESET = (id = "cmd-9"): DeviceCommand => ({ id, type: "RESET", order_id: 0 });

function sealed() {
  const h = makeCore();
  h.core.boot();
  h.core.handleCommand(SEAL());
  assert.equal(h.core.state, "SEALED");
  return h;
}

/** An in-memory relayer: the real verifyBatch plus a one-slot command queue. */
function fakeRelayer(secretHex = SECRET) {
  let state: BoxIngestState = { boxId: BOX, lastSeq: 0, lastHead: GENESIS_HEAD, seenSeq1Heads: new Set() };
  const heads = new Map<number, string>();
  const accepted: Array<{ seq: number; type: string; code: number }> = [];
  const gaps: number[] = [];
  let command: DeviceCommand | null = null;
  const fetchFn: FetchLike = async (_url, init) => {
    const batch = JSON.parse(init.body) as WireBatch;
    const out = verifyBatch(state, batch, { secretHex, headAt: (s) => heads.get(s) });
    if (!out.ok) return { status: out.status, json: async () => out.body };
    state = out.newState;
    for (const e of out.accepted) {
      heads.set(e.seq, e.head);
      accepted.push({ seq: e.seq, type: e.type, code: e.code });
      if (command && e.cmd_id === command.id) command = null;
    }
    if (out.gap) gaps.push(out.accepted[0]!.seq);
    return { status: 200, json: async () => ({ ok: true, ack_seq: out.ackSeq, command }) };
  };
  return {
    fetch: fetchFn,
    accepted,
    gaps,
    get state() {
      return state;
    },
    setCommand(c: DeviceCommand | null) {
      command = c;
    },
  };
}

async function drain(net: BoxNet, core: BoxCore) {
  for (let i = 0; i < 50 && core.outbox.length > 0; i++) await net.pumpOnce();
}

// --- reboot mapping -----------------------------------------------------------
test("boot: first boot is IDLE with a BOOT event at seq 1 from the genesis head", () => {
  const { core } = makeCore();
  const evs = core.boot();
  assert.deepEqual(evs.map((e) => e.type), ["BOOT"]);
  assert.equal(evs[0]!.seq, 1);
  assert.equal(core.state, "IDLE");
  assert.equal(core.lock, "U");
});

test("reboot mapping: SEALED -> TAMPERED with POWER_INTERRUPTED (3), latched before reporting", () => {
  const { core, nvs } = sealed();
  const evs = core.powerCycle();
  assert.equal(core.state, "TAMPERED");
  assert.equal(core.lock, "L");
  assert.deepEqual(evs.map((e) => [e.type, e.code, e.state]), [["BOOT", 0, "TAMPERED"], ["TAMPER", 3, "TAMPERED"]]);
  assert.equal(evs[1]!.order_id, 7);
  const saved = nvs.load()!;
  assert.equal(saved.state, "TAMPERED");
  assert.equal(saved.tamper_code, 3);
  assert.equal(saved.seq, evs[1]!.seq, "NVS holds the seq of the last queued event");
});

test("reboot mapping: TAMPERED stays TAMPERED and re-emits TAMPER with its original code on every boot", () => {
  const { core, advance } = sealed();
  core.liftLid();
  advance(250);
  assert.equal(core.tamperCode, 1);
  for (let i = 0; i < 2; i++) {
    const evs = core.powerCycle();
    assert.equal(core.state, "TAMPERED");
    assert.deepEqual(evs.map((e) => [e.type, e.code]), [["BOOT", 0], ["TAMPER", 1]]);
  }
});

test("reboot mapping: OPEN_AUTHORIZED and ARMING come back IDLE and unlocked, order cleared", () => {
  const h = sealed();
  h.core.handleCommand(UNLOCK());
  h.core.tapTag("RIGHT");
  assert.equal(h.core.state, "OPEN_AUTHORIZED");
  let evs = h.core.powerCycle();
  assert.equal(h.core.state, "IDLE");
  assert.equal(h.core.orderId, 0);
  assert.deepEqual(evs.map((e) => e.type), ["BOOT"]);

  const nvs = new MemoryNvs();
  nvs.save({ version: 1, box_id: BOX, seq: 5, head: "ab".repeat(32), state: "ARMING", order_id: 3, tamper_code: 0, boot_count: 1 });
  const { core } = makeCore(nvs);
  evs = core.boot();
  assert.equal(core.state, "IDLE");
  assert.equal(evs[0]!.seq, 6, "seq continues from NVS");
});

test("reboot mapping: TAMPERED with no order does not re-emit TAMPER", () => {
  const nvs = new MemoryNvs();
  nvs.save({ version: 1, box_id: BOX, seq: 2, head: "cd".repeat(32), state: "TAMPERED", order_id: 0, tamper_code: 1, boot_count: 1 });
  const { core } = makeCore(nvs);
  assert.deepEqual(core.boot().map((e) => e.type), ["BOOT"]);
  assert.equal(core.state, "TAMPERED");
});

// --- seal -------------------------------------------------------------------
test("SEAL in IDLE locks, binds the order and acks with SEALED + cmd_id", () => {
  const { core } = makeCore();
  core.boot();
  const evs = core.handleCommand(SEAL(7, "cmd-1"));
  assert.deepEqual(evs.map((e) => [e.type, e.cmd_id, e.lock, e.order_id]), [["SEALED", "cmd-1", "L", 7]]);
  assert.deepEqual(core.handleCommand(SEAL(7, "cmd-1")), [], "a resent SEAL is not acked twice");
});

test("SEAL is refused with SEAL_FAILED when the lid is open or the battery is below 10.5 V", () => {
  const a = makeCore();
  a.core.boot();
  a.core.liftLid();
  let evs = a.core.handleCommand(SEAL(7, "cmd-1"));
  assert.deepEqual(evs.map((e) => [e.type, e.cmd_id, e.state, e.lock]), [["SEAL_FAILED", "cmd-1", "IDLE", "U"]]);
  assert.equal(a.core.state, "IDLE");

  const b = makeCore();
  b.core.boot();
  b.core.setBatteryMv(10_400);
  evs = b.core.handleCommand(SEAL(7, "cmd-1"));
  assert.equal(evs[0]!.type, "SEAL_FAILED");
  assert.equal(b.core.state, "IDLE");
  b.core.setBatteryMv(11_700);
  assert.equal(b.core.handleCommand(SEAL(7, "cmd-3"))[0]!.type, "SEALED");
});

// --- two-factor unlock ------------------------------------------------------
test("two-factor: UNLOCK only arms (no event, no ack); the RIGHT tag then opens and acks UNLOCKED with the armed cmd_id", () => {
  const { core } = sealed();
  assert.deepEqual(core.handleCommand(UNLOCK(7, "cmd-2")), []);
  assert.equal(core.state, "SEALED");
  assert.equal(core.lock, "L");
  assert.equal(core.armed, true);
  assert.equal(core.led(), "blue");
  assert.deepEqual(core.handleCommand(UNLOCK(7, "cmd-2")), [], "a resent UNLOCK while armed is idempotent");
  const evs = core.tapTag("RIGHT");
  assert.deepEqual(evs.map((e) => [e.type, e.cmd_id, e.state, e.lock]), [["UNLOCKED", "cmd-2", "OPEN_AUTHORIZED", "U"]]);
  assert.equal(core.led(), "green");
});

test("UNLOCK for a different order does not arm the box", () => {
  const { core } = sealed();
  core.handleCommand(UNLOCK(99, "cmd-2"));
  assert.equal(core.armed, false);
});

test("RIGHT tag before the box is armed opens nothing and sends nothing", () => {
  const { core } = sealed();
  assert.deepEqual(core.tapTag("RIGHT"), []);
  assert.equal(core.state, "SEALED");
  assert.equal(core.lock, "L");
});

test("WRONG tag on a sealed box: stays locked, ALERT 17 AUTH_FAILED, no state change (armed or not)", () => {
  const { core } = sealed();
  let evs = core.tapTag("WRONG");
  assert.deepEqual(evs.map((e) => [e.type, e.code, e.state, e.lock]), [["ALERT", 17, "SEALED", "L"]]);
  core.handleCommand(UNLOCK());
  evs = core.tapTag("WRONG");
  assert.deepEqual(evs.map((e) => [e.type, e.code]), [["ALERT", 17]]);
  assert.equal(core.armed, true, "a wrong tag does not disarm");
  assert.equal(core.led(), "red");
});

test("taps in IDLE give LED feedback only", () => {
  const { core } = makeCore();
  core.boot();
  assert.deepEqual(core.tapTag("WRONG"), []);
  assert.equal(core.led(), "red");
  assert.deepEqual(core.tapTag("RIGHT"), []);
  assert.equal(core.led(), "green");
});

// --- tamper -----------------------------------------------------------------
test("lid tamper needs 4 consecutive 50 ms open samples; a shorter lift does not latch", () => {
  const { core, advance } = sealed();
  core.liftLid();
  advance(150); // 3 samples
  assert.equal(core.state, "SEALED");
  core.closeLid();
  advance(50); // counter resets
  core.liftLid();
  advance(150);
  assert.equal(core.state, "SEALED");
  advance(50); // 4th consecutive
  assert.equal(core.state, "TAMPERED");
  assert.equal(core.tamperCode, 1);
  assert.equal(core.lock, "L");
  const tamper = core.outbox.filter((e) => e.type === "TAMPER");
  assert.equal(tamper.length, 1);
  assert.equal(tamper[0]!.lid, 0);
  assert.equal(core.urgentPending, true, "TAMPER is flushed at priority");
  assert.equal(core.led(), "red-blink");
});

test("the lid is only watched in SEALED: lifting it in OPEN_AUTHORIZED is not tamper", () => {
  const { core, advance } = sealed();
  core.handleCommand(UNLOCK());
  core.tapTag("RIGHT");
  core.liftLid();
  advance(1000);
  assert.equal(core.state, "OPEN_AUTHORIZED");
});

test("the tamper latch survives lid close, taps, UNLOCK, SEAL and power cycles; only RESET clears it", () => {
  const { core, advance } = sealed();
  core.handleCommand(UNLOCK());
  core.liftLid();
  advance(200);
  assert.equal(core.state, "TAMPERED");
  assert.equal(core.armed, false, "tamper disarms");
  core.closeLid();
  advance(500);
  core.tapTag("RIGHT");
  core.handleCommand(UNLOCK(7, "cmd-5"));
  core.handleCommand(SEAL(8, "cmd-6"));
  core.powerCycle();
  core.tapTag("RIGHT");
  assert.equal(core.state, "TAMPERED");
  assert.equal(core.lock, "L");
  assert.equal(core.orderId, 7);
  const evs = core.handleCommand(RESET("cmd-9"));
  assert.deepEqual(evs.map((e) => [e.type, e.cmd_id, e.state, e.lock, e.order_id]), [["RESET_DONE", "cmd-9", "IDLE", "U", 0]]);
  assert.equal(core.tamperCode, 0);
  assert.deepEqual(core.handleCommand(RESET("cmd-9")), [], "a resent RESET is not acked twice");
});

test("RESET is ignored while SEALED", () => {
  const { core } = sealed();
  assert.deepEqual(core.handleCommand(RESET()), []);
  assert.equal(core.state, "SEALED");
});

// --- alerts -----------------------------------------------------------------
test("shock raises ALERT 10 at most once per 10 s; tilt raises ALERT 11 once per 3 s excursion; neither changes state", () => {
  const { core, advance } = sealed();
  core.shock();
  advance(50);
  core.shock();
  advance(50);
  assert.equal(core.outbox.filter((e) => e.type === "ALERT" && e.code === 10).length, 1);
  advance(10_000);
  core.shock();
  advance(50);
  assert.equal(core.outbox.filter((e) => e.type === "ALERT" && e.code === 10).length, 2);

  core.tilt(2_500); // too short
  advance(3_000);
  assert.equal(core.outbox.filter((e) => e.code === 11).length, 0);
  core.tilt(4_000);
  advance(4_500);
  assert.equal(core.outbox.filter((e) => e.code === 11).length, 1);
  assert.equal(core.state, "SEALED");
});

test("telemetry cadence: every 2 s in SEALED, every 10 s otherwise; GPS always fix 0 and 0/0", () => {
  const idle = makeCore();
  idle.core.boot();
  idle.advance(9_950);
  assert.equal(idle.core.outbox.filter((e) => e.type === "TELEMETRY").length, 0);
  idle.advance(100);
  assert.equal(idle.core.outbox.filter((e) => e.type === "TELEMETRY").length, 1);

  const s = sealed();
  s.advance(10_000);
  const tel = s.core.outbox.filter((e) => e.type === "TELEMETRY");
  assert.ok(tel.length >= 4 && tel.length <= 5, `got ${tel.length}`);
  for (const e of tel) {
    assert.equal(e.fix, 0);
    assert.equal(e.lat_e6, 0);
    assert.equal(e.lon_e6, 0);
    assert.equal(e.lid, 1);
    assert.ok(Math.abs(e.accel_mg - 1000) < 50);
    assert.ok(e.batt_mv > 11_000);
  }
});

// --- persistence ------------------------------------------------------------
test("persistence round trip: a restarted process continues seq/head and the relayer verifies across it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-sim-"));
  const file = path.join(dir, "state.json");
  const relayer = fakeRelayer();

  const a = makeCore(new FileNvs(file));
  const netA = new BoxNet({ core: a.core, relayerUrl: "http://x", secretHex: SECRET, fetch: relayer.fetch });
  a.core.boot();
  a.core.handleCommand(SEAL());
  a.advance(4_000);
  await drain(netA, a.core);
  const seqBefore = a.core.seq;
  const headBefore = a.core.head;

  // New process, same file: this is a power cycle while SEALED.
  const b = makeCore(new FileNvs(file), a.clock.now + 5_000);
  const netB = new BoxNet({ core: b.core, relayerUrl: "http://x", secretHex: SECRET, fetch: relayer.fetch });
  const evs = b.core.boot();
  assert.equal(evs[0]!.seq, seqBefore + 1);
  assert.equal(b.core.state, "TAMPERED");
  await drain(netB, b.core);
  assert.equal(relayer.state.lastSeq, seqBefore + 2);
  assert.deepEqual(relayer.gaps, []);
  assert.notEqual(relayer.state.lastHead, headBefore);
  assert.equal(relayer.state.lastHead, b.core.head, "relayer's recomputed head equals the box's head");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a corrupt state file is a hard error, never a silent restart at seq 1", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-sim-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "{not json");
  assert.throws(() => new FileNvs(file).load(), /--fresh/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- networking -------------------------------------------------------------
test("offline buffering: events queue while Wi-Fi is off, then flush in order with continuous seq and no gap", async () => {
  const relayer = fakeRelayer();
  const { core, advance } = makeCore();
  const net = new BoxNet({ core, relayerUrl: "http://x", secretHex: SECRET, fetch: relayer.fetch });
  core.boot();
  await drain(net, core);
  relayer.setCommand(SEAL(7, "cmd-1"));
  core.telemetryNow();
  await net.pumpOnce(); // delivers SEAL
  assert.equal(core.state, "SEALED");
  await drain(net, core);

  net.setOffline(true);
  advance(30_000); // ~15 telemetry events
  core.tapTag("WRONG");
  assert.equal(await net.pumpOnce(), null);
  assert.ok(core.outbox.length >= 15, `buffered ${core.outbox.length}`);
  const firstBuffered = core.outbox[0]!.seq;

  net.setOffline(false);
  await drain(net, core);
  assert.equal(core.outbox.length, 0);
  assert.deepEqual(relayer.gaps, [], "no LOG_GAP: nothing was lost");
  const seqs = relayer.accepted.map((e) => e.seq);
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), "every seq arrives once, in order");
  assert.ok(seqs.includes(firstBuffered));
  assert.equal(relayer.accepted.at(-1)!.code, 17);
  assert.equal(net.link.lastAckSeq, core.seq);
});

test("ring overflow drops the oldest events; the relayer accepts the rest with LOG_GAP", async () => {
  const relayer = fakeRelayer();
  const { core, advance } = sealed();
  const net = new BoxNet({ core, relayerUrl: "http://x", secretHex: SECRET, fetch: relayer.fetch });
  await drain(net, core);
  net.setOffline(true);
  advance(2_000 * (RING_CAPACITY + 10));
  assert.equal(core.outbox.length, RING_CAPACITY);
  assert.ok(core.droppedFromRing >= 10);
  net.setOffline(false);
  await drain(net, core);
  assert.equal(relayer.gaps.length, 1);
  assert.equal(relayer.state.lastSeq, core.seq);
  assert.equal(relayer.state.lastHead, core.head);
});

test("401 and 409 keep the events buffered and never touch the local chain", async () => {
  const wrong = fakeRelayer("22".repeat(32));
  const { core } = makeCore();
  const logs: string[] = [];
  const net = new BoxNet({ core, relayerUrl: "http://x", secretHex: SECRET, fetch: wrong.fetch, log: (_l, t) => logs.push(t) });
  core.boot();
  const seq = core.seq;
  const head = core.head;
  await net.pumpOnce();
  assert.equal(net.link.lastStatus, 401);
  assert.equal(core.outbox.length, 1);
  assert.equal(core.seq, seq);
  assert.equal(core.head, head);
  assert.ok(!logs.join("\n").includes(SECRET), "the secret never appears in a log line");

  const conflict: FetchLike = async () => ({ status: 409, json: async () => ({ ok: false, error: "mismatched head at seq 1", expected_seq: 1 }) });
  const net2 = new BoxNet({ core, relayerUrl: "http://x", secretHex: SECRET, fetch: conflict });
  await net2.pumpOnce();
  assert.equal(net2.link.lastStatus, 409);
  assert.match(net2.link.lastError ?? "", /expected seq 1/);
  assert.equal(core.outbox.length, 1);
  assert.equal(core.seq, seq);
});

test("a POST response that lands after a power cycle does not deliver its command to the rebooted box", async () => {
  const { core } = sealed();
  let release!: () => void;
  const slow: FetchLike = () =>
    new Promise((resolve) => {
      release = () => resolve({ status: 200, json: async () => ({ ok: true, ack_seq: 1, command: UNLOCK() }) });
    });
  const net = new BoxNet({ core, relayerUrl: "http://x", secretHex: SECRET, fetch: slow });
  const p = net.pumpOnce();
  core.powerCycle(); // now TAMPERED
  release();
  assert.equal(await p, null);
  assert.equal(core.armed, false);
});

// --- config -----------------------------------------------------------------
test("resolveSecret: BOX_SECRET_HEX wins; else BOX_SECRETS from the .env file; errors never contain the secret", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-sim-"));
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, `CHAIN=local\nBOX_SECRETS={"TS-BOX-01":"${"ab".repeat(32)}"}\n`);
  assert.equal(resolveSecret(BOX, { BOX_SECRET_HEX: SECRET }, envFile).secretHex, SECRET);
  assert.equal(resolveSecret(BOX, {}, envFile).secretHex, "ab".repeat(32));
  assert.throws(() => resolveSecret("OTHER", {}, envFile), /no entry for OTHER/);
  const bad = "zz" + "ab".repeat(31);
  assert.throws(
    () => resolveSecret(BOX, { BOX_SECRET_HEX: bad }, envFile),
    (err: Error) => !err.message.includes(bad) && /not a 64-character hex/.test(err.message),
  );
  fs.writeFileSync(envFile, `BOX_SECRETS={"TS-BOX-01":"${bad}"}\n`);
  assert.throws(
    () => resolveSecret(BOX, {}, envFile),
    (err: Error) => !err.message.includes(bad),
  );
  assert.throws(() => resolveSecret(BOX, {}, path.join(dir, "missing.env")), /no box secret/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- UI ---------------------------------------------------------------------
test("renderFrame renders every state, with and without colour/unicode, at wide and narrow widths", () => {
  const base: UiSnapshot = {
    now: Date.now(),
    boxId: BOX,
    relayerUrl: "http://127.0.0.1:4000",
    relayerChain: "local",
    link: { state: "ok", lastStatus: 200, lastAckSeq: 42, lastError: null, lastOkAt: Date.now(), failures: 0 },
    offline: false,
    state: "IDLE",
    orderId: 3,
    lock: "L",
    lidClosed: true,
    armed: true,
    led: "blue",
    battMv: 11_700,
    accelMg: 1003,
    tiltDeg: 1,
    seq: 42,
    head: "3f2a9b1c".repeat(8),
    buffered: 0,
    dropped: 0,
    tamperCode: 1,
    log: Array.from({ length: 12 }, (_, i) => ({ at: Date.now(), kind: "event" as const, level: "info" as const, text: `#${i} TELEMETRY`, type: "TELEMETRY" })),
    banner: null,
    auto: null,
  };
  for (const state of ["BOOT", "IDLE", "ARMING", "SEALED", "TAMPERED", "OPEN_AUTHORIZED"] as const) {
    for (const [cols, rows] of [[120, 30], [50, 24]] as const) {
      for (const color of [true, false]) {
        const lines = renderFrame({ ...base, state, led: state === "TAMPERED" ? "red-blink" : "blue" }, { cols, rows, color, unicode: color });
        assert.ok(lines.length <= rows, `${state} at ${cols}x${rows}: ${lines.length} lines`);
        assert.ok(lines.join("\n").length > 0);
        if (cols === 120) assert.ok(lines.some((l) => /[█▀▄#]/.test(l)), "big state word drawn");
      }
    }
  }
  const err = renderFrame(
    { ...base, link: { ...base.link, state: "rejected", lastStatus: 409, lastError: "409 FORGERY CHECK: relayer expected seq 5 ".repeat(5) } },
    { cols: 60, rows: 30, color: true, unicode: true },
  );
  assert.ok(err.some((l) => l.includes("409 FORGERY")));
  assert.ok(err.every((l) => visibleLength(l) <= 120));
});
