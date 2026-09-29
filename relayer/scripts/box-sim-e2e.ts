// End-to-end check for the SIMULATED BOX against a LOCAL stack only:
//   npm run box:e2e
// Spawns a fresh `hardhat node` (chainId 31337, checked before any tx),
// deploys, starts the relayer with a runtime-generated dummy box secret, then
// drives the real box-sim core + network task over HTTP and asserts on chain:
//   A. happy path: right tag before requestUnlock opens nothing; after
//      requestUnlock a WRONG tag logs Alert 17 on chain and changes nothing;
//      only the RIGHT tag then reaches Delivered (exact balance deltas).
//   B. lid lifted while sealed -> Tampered, buyer refunded, bond slashed.
//   C. power cycle while sealed -> Tampered; a second power cycle re-emits
//      TAMPER and the relayer still sends exactly one reportTamper.
//   D. GET /api/orders/:id/log verifies (match true) for every order.
// Finally it launches `npm run box`'s script as a non-TTY child to prove the
// CLI shell connects, and that its output never contains the secret.
//
// Buyer/courier actions are signed by Hardhat dev accounts through
// wallet-actions.ts (no private key anywhere). Never targets MST.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { WalletActions, ACCOUNT_INDEX, defaultDeps } from "./wallet-actions.js";
import { snapshotBalances, assertHappyOutcome, assertTamperOutcome, TxFailureWatcher, type Balances } from "./checker.js";
import { BoxCore, FileNvs } from "./box-sim-core.js";
import { BoxNet, BoxRuntime } from "./box-sim-net.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RELAYER_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(RELAYER_DIR, "..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts");
const RPC_PORT = 8545;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const RELAYER_PORT = 4200;
const RELAYER_URL = `http://127.0.0.1:${RELAYER_PORT}`;
const LOCAL_CHAIN_ID = 31337n;

// Escrow.Status, ARCHITECTURE.md §6
const S = { Funded: 1, InTransit: 2, UnlockRequested: 3, Delivered: 4, Tampered: 5 } as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (msg: string) => console.log(`[box:e2e] ${msg}`);

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

function hardhatCliPath(): string {
  const pkgPath = path.join(CONTRACTS_DIR, "node_modules", "hardhat", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.hardhat;
  if (!bin) throw new Error("box:e2e: could not find hardhat's CLI entrypoint");
  return path.join(CONTRACTS_DIR, "node_modules", "hardhat", bin);
}

function waitForStdout(child: ChildProcess, marker: string, label: string, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`box:e2e: ${label} never printed "${marker}" within ${timeoutMs} ms`)), timeoutMs);
    const onData = (d: Buffer) => {
      if (process.env.E2E_VERBOSE) process.stdout.write(`[${label}] ${d}`);
      if (d.toString().includes(marker)) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (d) => process.stderr.write(`[${label}-err] ${d}`));
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) reject(new Error(`box:e2e: ${label} exited early with code ${code}`));
    });
  });
}

function waitForExit(child: ChildProcess, label: string, echo = true): Promise<number> {
  return new Promise((resolve, reject) => {
    if (echo) {
      child.stdout?.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
      child.stderr?.on("data", (d) => process.stderr.write(`[${label}-err] ${d}`));
    }
    child.on("exit", (code) => resolve(code ?? -1));
    child.on("error", reject);
  });
}

/** Windows: child.kill() on a node child is fine, but taskkill /T also takes
 * any grandchildren. Wait for taskkill itself to finish. */
async function killTree(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    await new Promise((r) => tk.on("exit", r));
  } else {
    child.kill("SIGTERM");
  }
}

async function waitFor<T>(label: string, fn: () => T | Promise<T>, timeoutMs = 30_000, everyMs = 250): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    await sleep(everyMs);
  }
  throw new Error(`box:e2e: timed out waiting for ${label}${last ? ` (last error: ${String(last)})` : ""}`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`box:e2e: ASSERTION FAILED: ${msg}`);
}

let hardhatNode: ChildProcess | undefined;
let relayer: ChildProcess | undefined;
let cli: ChildProcess | undefined;

process.on("SIGINT", () => {
  console.log("\n[box:e2e] SIGINT, tearing down...");
  void Promise.all([killTree(cli), killTree(relayer), killTree(hardhatNode)]).then(() => process.exit(130));
});

async function main(): Promise<void> {
  for (const port of [RPC_PORT, RELAYER_PORT]) {
    if (!(await portFree(port))) throw new Error(`box:e2e: port ${port} is already in use. Stop whatever is on it first (this check only ever uses a fresh local stack).`);
  }

  const runDir = path.join(RELAYER_DIR, "_scenario-data", `box-e2e-${Date.now()}`);
  let runtime: BoxRuntime | undefined;
  let txWatcher: TxFailureWatcher | undefined;
  let passed = false;

  try {
    const hh = hardhatCliPath();
    say("starting hardhat node...");
    hardhatNode = spawn(process.execPath, [hh, "node"], { cwd: CONTRACTS_DIR });
    await waitForStdout(hardhatNode, "Started HTTP", "hardhat-node");

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
    const chainId = BigInt((await provider.send("eth_chainId", [])) as string);
    assert(chainId === LOCAL_CHAIN_ID, `RPC at ${RPC_URL} is chainId ${chainId}, not the local Hardhat ${LOCAL_CHAIN_ID}; refusing to continue`);

    say("deploying contracts to the local node...");
    const deploy = spawn(process.execPath, [hh, "run", "scripts/deploy.ts", "--network", "localhost"], { cwd: CONTRACTS_DIR });
    const deployCode = await waitForExit(deploy, "deploy", Boolean(process.env.E2E_VERBOSE));
    if (deployCode !== 0) throw new Error(`box:e2e: deploy exited with code ${deployCode}`);

    const deployment = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "deployments", "local.json"), "utf8")) as {
      chainId: number;
      contracts: { TelemetryAnchor: { address: string } };
      boxes: Array<{ label: string }>;
    };
    assert(BigInt(deployment.chainId) === LOCAL_CHAIN_ID, "deployments/local.json is not chainId 31337");
    const boxId = deployment.boxes[0]!.label;
    const secretHex = randomBytes(32).toString("hex"); // runtime-only dummy, never written anywhere

    say("starting relayer (CHAIN=local)...");
    relayer = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: RELAYER_DIR,
      env: {
        ...process.env,
        CHAIN: "local",
        LOCAL_RPC: RPC_URL,
        ORACLE_PRIVATE_KEY: "", // local signs with an unlocked dev account; keep any .env value out
        BOX_SECRETS: JSON.stringify({ [boxId]: secretHex }),
        PORT: String(RELAYER_PORT),
        DATA_DIR: runDir,
      },
    });
    await waitForStdout(relayer, "listening on", "relayer");
    await waitFor("relayer health", async () => (await fetch(`${RELAYER_URL}/api/health`)).ok, 15_000);
    txWatcher = new TxFailureWatcher(RELAYER_URL);

    // --- the simulated box, in-process, on real timers ---------------------
    const stateFile = path.join(runDir, `box-sim-${boxId}.json`);
    const core = new BoxCore({
      boxId,
      nvs: new FileNvs(stateFile),
      onEvent: (e) => {
        if (e.type !== "TELEMETRY") say(`  box -> #${e.seq} ${e.type}${e.code ? ` code ${e.code}` : ""} ${e.state}${e.cmd_id ? ` cmd=${e.cmd_id}` : ""}`);
      },
    });
    const boxNet = new BoxNet({
      core,
      relayerUrl: RELAYER_URL,
      secretHex,
      log: (level, text) => {
        if (level !== "info" || process.env.E2E_VERBOSE) say(`  net ${level}: ${text}`);
      },
    });
    runtime = new BoxRuntime(core, boxNet);
    // Read through a function: the box mutates behind TypeScript's back, so
    // narrowing core.state after one assert would be wrong for the next.
    const st = (): string => core.state;
    runtime.start();
    await waitFor("box BOOT accepted", () => boxNet.link.state === "ok" && core.outbox.length === 0, 15_000);

    const anchorIface = new ethers.Interface(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "deployments", "abi", "TelemetryAnchor.json"), "utf8")));
    const alertTopic = anchorIface.getEvent("Alert")!.topicHash;

    const onChainAlerts = async (orderId: number): Promise<number[]> => {
      const logs = (await provider.send("eth_getLogs", [
        { address: deployment.contracts.TelemetryAnchor.address, fromBlock: "0x0", toBlock: "latest", topics: [alertTopic, ethers.zeroPadValue(ethers.toBeHex(orderId), 32)] },
      ])) as Array<{ topics: string[]; data: string }>;
      return logs.map((l) => Number(anchorIface.parseLog(l)!.args.code));
    };

    const verifyLog = async (orderId: number) => {
      const log = (await (await fetch(`${RELAYER_URL}/api/orders/${orderId}/log`)).json()) as { anchored_seq: number; match: boolean | null };
      assert(log.anchored_seq > 0 && log.match === true, `GET /api/orders/${orderId}/log did not verify (anchored_seq=${log.anchored_seq}, match=${log.match})`);
      say(`  log verify for order ${orderId}: anchored_seq ${log.anchored_seq}, match true`);
    };

    // One scenario's wallet and starting point. A fresh WalletActions per
    // scenario keeps checker.ts's per-account fee tracking exact.
    const startOrder = async () => {
      const wallet = new WalletActions(defaultDeps(REPO_ROOT, "local"));
      const addrs = {
        buyer: await wallet.addressOf(ACCOUNT_INDEX.buyer),
        seller: await wallet.addressOf(ACCOUNT_INDEX.seller),
        courier: await wallet.addressOf(ACCOUNT_INDEX.courier),
      };
      assert((await wallet.bondBalance(addrs.courier)) === 0n, "courier starts the scenario with no free bond");
      const before: Balances = await snapshotBalances(wallet, addrs);
      const depositWei = ethers.parseEther("0.02");
      const amountWei = ethers.parseEther("0.01");
      await wallet.depositBond(depositWei);
      const orderId = await wallet.createOrder({ sellerAddress: addrs.seller, destLat: 12971599, destLon: 77594566, deadlineUnix: Math.floor(Date.now() / 1000) + 3600, valueWei: amountWei });
      const status = async () => Number((await wallet.getOrder(orderId)).status);

      say(`  order ${orderId} created; depot seals ${boxId} through the relayer`);
      const seal = (await (await fetch(`${RELAYER_URL}/api/orders/${orderId}/seal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ box_id: boxId, courier: addrs.courier }),
      })).json()) as { ok: boolean; error?: string };
      assert(seal.ok, `seal REST call failed: ${JSON.stringify(seal)}`);
      await waitFor("box SEALED", () => core.state === "SEALED", 25_000);
      await waitFor("order InTransit on chain", async () => (await status()) === S.InTransit, 20_000);
      return { wallet, addrs, before, depositWei, amountWei, orderId, status };
    };

    const finishOrder = async (wallet: WalletActions, courier: string) => {
      const free = await wallet.bondBalance(courier);
      if (free > 0n) await wallet.withdrawBond(free);
    };

    const resetBox = async () => {
      core.closeLid();
      const res = (await (await fetch(`${RELAYER_URL}/api/boxes/${boxId}/reset`, { method: "POST" })).json()) as { ok: boolean; error?: string };
      assert(res.ok, `reset REST call failed: ${JSON.stringify(res)}`);
      await waitFor("box IDLE after RESET", () => core.state === "IDLE", 25_000);
      await waitFor("relayer command slot empty", async () => {
        const boxes = (await (await fetch(`${RELAYER_URL}/api/boxes`)).json()) as { boxes: Array<{ label: string; pendingCommand: unknown }> };
        return boxes.boxes.find((b) => b.label === boxId)?.pendingCommand === null && core.outbox.length === 0;
      }, 15_000);
    };

    // ======================= A. happy path, two-factor ======================
    say("A. happy path with two-factor unlock");
    {
      const o = await startOrder();

      say("  Wi-Fi off for 5 s while sealed, then back on");
      boxNet.setOffline(true);
      await sleep(5_000);
      const buffered = core.outbox.length;
      assert(buffered >= 2, `expected buffered telemetry while offline, got ${buffered}`);
      boxNet.setOffline(false);
      await waitFor("offline buffer flushed", () => core.outbox.length === 0 && boxNet.link.state === "ok", 15_000);
      say(`  flushed ${buffered} buffered event(s)`);

      say("  delivery key tapped BEFORE requestUnlock");
      assert(core.tapTag("RIGHT").length === 0, "right tag before arming must not emit anything");
      await sleep(2_500);
      assert(st() === "SEALED" && core.lock === "L", "box stays sealed");
      assert((await o.status()) === S.InTransit, "order stays InTransit");

      say("  buyer signs requestUnlock");
      await o.wallet.requestUnlock(o.orderId);
      await waitFor("box armed by UNLOCK", () => core.armed, 20_000);
      await sleep(3_000);
      assert(st() === "SEALED" && core.lock === "L", "UNLOCK alone must not open the box");
      assert((await o.status()) === S.UnlockRequested, "order is UnlockRequested while armed");

      say("  WRONG tag tapped on the armed box");
      assert(core.tapTag("WRONG")[0]?.code === 17, "wrong tag emits ALERT 17");
      const alerts = await waitFor("on-chain Alert code 17", async () => ((await onChainAlerts(o.orderId)).includes(17) ? await onChainAlerts(o.orderId) : null), 20_000);
      say(`  on-chain Alert codes for order ${o.orderId}: ${alerts.join(", ")}`);
      await sleep(2_000);
      assert((await o.status()) === S.UnlockRequested, "wrong tag changes no on-chain state");
      assert(st() === "SEALED" && core.lock === "L" && core.armed, "wrong tag leaves the box locked and armed");

      say("  RIGHT tag tapped");
      assert(core.tapTag("RIGHT")[0]?.type === "UNLOCKED", "right tag while armed emits UNLOCKED");
      await waitFor("order Delivered", async () => (await o.status()) === S.Delivered, 20_000);
      const after = await snapshotBalances(o.wallet, o.addrs);
      await assertHappyOutcome({ wallet: o.wallet, orderId: o.orderId, amountWei: o.amountWei, depositWei: o.depositWei, before: o.before, after, buyerAddr: o.addrs.buyer, sellerAddr: o.addrs.seller, courierAddr: o.addrs.courier });
      say("  Delivered; seller paid, bond unlocked (exact deltas)");
      await verifyLog(o.orderId);
      await finishOrder(o.wallet, o.addrs.courier);
      await resetBox();
    }

    // ======================= B. lid tamper =================================
    say("B. lid lifted while sealed");
    let tamperOrder = 0;
    {
      const o = await startOrder();
      tamperOrder = o.orderId;
      core.liftLid();
      await waitFor("box TAMPERED", () => core.state === "TAMPERED", 5_000);
      await waitFor("order Tampered", async () => (await o.status()) === S.Tampered, 20_000);
      core.closeLid();
      core.tapTag("RIGHT");
      await sleep(1_000);
      assert(st() === "TAMPERED" && core.lock === "L", "latch survives closing the lid and the delivery key");
      const after = await snapshotBalances(o.wallet, o.addrs);
      const bondWei = (o.amountWei * (await o.wallet.bondBps())) / 10_000n;
      await assertTamperOutcome({ wallet: o.wallet, orderId: o.orderId, amountWei: o.amountWei, bondWei, depositWei: o.depositWei, before: o.before, after, buyerAddr: o.addrs.buyer, courierAddr: o.addrs.courier });
      say("  Tampered; buyer refunded, courier bond slashed to seller (exact deltas)");
      await verifyLog(o.orderId);
      await finishOrder(o.wallet, o.addrs.courier);
      await resetBox();
    }

    // ======================= C. power cycle while sealed ====================
    say("C. power cycle while sealed");
    let powerOrder = 0;
    {
      const o = await startOrder();
      powerOrder = o.orderId;
      await waitFor("box buffer empty before the power cut", () => core.outbox.length === 0, 10_000);
      runtime.powerCycle();
      assert(st() === "TAMPERED" && core.tamperCode === 3, "boot from SEALED latches POWER_INTERRUPTED");
      await waitFor("order Tampered", async () => (await o.status()) === S.Tampered, 20_000);
      say("  second power cycle (TAMPER re-emitted, must be a no-op on chain)");
      await waitFor("buffer empty", () => core.outbox.length === 0, 10_000);
      runtime.powerCycle();
      await waitFor("re-emitted TAMPER acked", () => core.outbox.length === 0 && boxNet.link.state === "ok", 15_000);
      await sleep(3_000);
      const after = await snapshotBalances(o.wallet, o.addrs);
      const bondWei = (o.amountWei * (await o.wallet.bondBps())) / 10_000n;
      await assertTamperOutcome({ wallet: o.wallet, orderId: o.orderId, amountWei: o.amountWei, bondWei, depositWei: o.depositWei, before: o.before, after, buyerAddr: o.addrs.buyer, courierAddr: o.addrs.courier });
      say("  Tampered; buyer refunded, courier bond slashed to seller (exact deltas)");
      await verifyLog(o.orderId);
      await finishOrder(o.wallet, o.addrs.courier);
      await resetBox();
    }

    // ======================= relayer's own tx record ========================
    await sleep(500);
    txWatcher.assertNoFailures();
    const confirmed = txWatcher.confirmed.map((c) => c.label);
    const count = (prefix: string) => confirmed.filter((l) => l.startsWith(prefix)).length;
    assert(count(`reportTamper(${tamperOrder},`) === 1, `exactly one reportTamper for order ${tamperOrder}, got ${count(`reportTamper(${tamperOrder},`)}`);
    assert(count(`reportTamper(${powerOrder},`) === 1, `exactly one reportTamper for order ${powerOrder} despite two power cycles, got ${count(`reportTamper(${powerOrder},`)}`);
    const alertTxs = confirmed.filter((l) => l.startsWith("logAlert("));
    assert(alertTxs.length === 1 && alertTxs[0]!.includes("code=17"), `the only logAlert is AUTH_FAILED (no LOG_GAP/SIGNAL_LOST), got ${JSON.stringify(alertTxs)}`);
    say(`  relayer tx record: ${confirmed.length} confirmed, 0 permanent failures; logAlert = ${alertTxs.join(", ")}`);

    // ======================= CLI shell smoke test ============================
    await runtime.stop();
    runtime = undefined;
    for (let i = 0; i < 10 && core.outbox.length > 0; i++) await boxNet.pumpOnce(); // hand over a clean chain tail
    say("CLI shell: npm run box as a non-TTY child against the local relayer");
    cli = spawn(process.execPath, ["--import", "tsx", "scripts/box-sim.ts", "--state", stateFile], {
      cwd: RELAYER_DIR,
      env: { ...process.env, RELAYER_URL, BOX_ID: boxId, BOX_SECRET_HEX: secretHex, BOX_SECRETS: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let cliOut = "";
    cli.stdout?.on("data", (d) => (cliOut += d.toString()));
    cli.stderr?.on("data", (d) => (cliOut += d.toString()));
    const cliExit = new Promise<number>((resolve) => cli!.on("exit", (c) => resolve(c ?? -1)));
    await waitFor("CLI link OK", () => cliOut.includes("relayer link OK"), 20_000);
    cli.stdin?.write("q");
    const code = await Promise.race([cliExit, sleep(15_000).then(() => -2)]);
    assert(code === 0, `CLI exited with ${code}. Output:\n${cliOut}`);
    assert(cliOut.includes("SIMULATED BOX") && cliOut.includes("BOOT"), "CLI printed its banner and booted");
    assert(!cliOut.toLowerCase().includes(secretHex), "CLI output never contains the box secret");
    say("  CLI connected (POST 200), quit cleanly, secret never printed");

    passed = true;
    say("PASS: happy (two-factor, wrong tag = on-chain Alert 17 only), lid tamper, power cycle, log verify, CLI.");
  } finally {
    say("tearing down...");
    if (runtime) await runtime.stop().catch(() => {});
    if (txWatcher) await txWatcher.stop().catch(() => {});
    await killTree(cli);
    await killTree(relayer);
    await killTree(hardhatNode);
    const freed = await waitFor("port 8545 released", () => portFree(RPC_PORT), 10_000).catch(() => false);
    if (!freed) console.warn("[box:e2e] WARNING: port 8545 still busy after teardown");
    if (passed) fs.rmSync(runDir, { recursive: true, force: true });
    else say(`run data kept for debugging: ${runDir}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[box:e2e] FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
