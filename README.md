# TamperSafe

**A tamper-evident container that locks itself at origin, watches itself in transit, and settles the payment on-chain by rules fixed before dispatch.**

A clean delivery pays the seller. Any tamper refunds the buyer and slashes the courier's bond to the seller. Built on **MST Blockchain** for the MST Blockchain x NEWRRO 24-Hour Buildathon.

| | |
| :--- | :--- |
| Chain | MST Testnet (chain id 91562037), explorer [testnet.mstscan.com](https://testnet.mstscan.com) |
| Escrow contract | [`0xC876A0F58592BE567081a752a0Ad53106EFD1223`](https://testnet.mstscan.com/address/0xC876A0F58592BE567081a752a0Ad53106EFD1223) |
| Wallet | [BridgeKey](https://bridgekey.io), the official MST wallet (preferred), or any EIP-1193 wallet |
| Hardware | NEWRRO Neurick (ESP32-S3) with IR lid sensor, MPU6050, RC522 RFID delivery key, and RGB status LED. The latch is logical in this build; a servo actuator is roadmap |
| More | [`pitch.md`](pitch.md) (problem, use cases, business model, limits) · [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/HARDWARE.md`](docs/HARDWARE.md) |

---

## Contents

1. [The problem](#the-problem)
2. [The solution](#the-solution)
3. [Why blockchain, and why MST](#why-blockchain-and-why-mst)
4. [What is built today](#what-is-built-today)
5. [Architecture](#architecture)
6. [Contract addresses](#contract-addresses-mst-testnet)
7. [Getting started](#getting-started)
8. [Use cases and business model](#use-cases-and-business-model)
9. [Trust model and limits](#trust-model-and-limits)
10. [Repository layout](#repository-layout)
11. [Open-source libraries and AI usage](#open-source-libraries)

---

## The problem

Every delivery is a three-party deal in which nobody can verify anybody. The buyer cannot prove the box was opened in transit. The seller cannot prove they shipped the right thing or that the courier did not swap it. The courier cannot prove they never touched it, and holds the goods with **nothing at stake**.

When something goes wrong, the dispute is one party's word against another's, decided by whoever runs the platform. Honest parties lose slowly, and dishonest ones win cheaply. Refunds decided on unverifiable claims are expensive: Appriss Retail reports that 15.14% of 2024 US returns were fraudulent, $103B in fraudulent returns and claims on $685B of total returns ([source](https://apprissretail.com/news/appriss-retail-annual-research-fraudulent-returns-and-claims-cost-retailers-103b-in-2024/)). Theft in transit is real too: CargoNet recorded 3,625 US cargo thefts in 2024, up 27%, averaging $202,364 each ([source](https://www.cargonet.com/news-and-events/cargonet-in-the-media/2024-theft-trends/)). In India, 60 to 65% of e-commerce orders are cash on delivery and roughly 25 to 30% of those end as return-to-origin, against 2 to 3% of prepaid orders ([blog source](https://razorpay.com/blog/cash-on-delivery/), primary source still needed).

Today's fixes each cover one piece. Tamper tape shows a seal broke, but the evidence is a photo. GPS trackers show where, not whether it was opened. Platform refunds put the decision with an interested party. Insurance needs proof of loss, which is exactly what is missing.

> There is no neutral, evidence-backed way to decide who is at fault when a sealed package arrives wrong, and no consequence for the party who caused it.

## The solution

TamperSafe makes **detection, evidence and settlement one system**. The box that detects a tamper is the same one whose report moves the money, under rules nobody can change after dispatch.

1. **Seal.** At the depot the box locks (a logical latch: it records and reports the locked state; the servo actuator is roadmap). The buyer's payment is already in escrow and the courier's bond is locked against the shipment.
2. **Transit.** The box watches its lid (IR), and motion and shock (MPU6050); its location is simulated on the dashboard (the box has no GPS). A tamper is latched in the box's non-volatile memory, and a reboot or power loss mid-transit counts as tamper.
3. **Report.** The box reports over Wi-Fi to a relayer. Every event is hash-chained and authenticated with a per-box secret. The relayer writes state changes to chain and anchors the log head.
4. **Settle.** The buyer confirms at the doorstep: they sign "Confirm & Unlock" on-chain, which arms the box (blue LED), then tap their RFID delivery key on it. The right key gives a green LED and opens the latch; a wrong tag gives red, the box stays locked and the attempt is logged as evidence. Once it opens, Clean delivery pays the seller. Any tamper refunds the buyer and slashes the courier's bond.

**Invariants the design holds to:**

- Funds move only through the escrow state machine. The relayer triggers defined transitions and **never names a payee**.
- The buyer's own wallet signs create, cancel and unlock.
- Tamper is latched in both the firmware and the contract.
- GPS is evidence only and never gates escrow. Simulated GPS is always labelled `SIMULATED`.
- Every state change the dashboard shows is an on-chain event with an explorer link.
- The whole flow runs without hardware (the relayer's sim-box) and without testnet (`CHAIN=local`).

**The box is one form, not the whole product.** The settlement and evidence layer is form-agnostic: the same loop of sense, latch, report and settle applies to containers, truck cargo bays and pallets. Only the sensing and latching layer changes per form, and only the parcel box exists today. See [`pitch.md`](pitch.md) section 4.

## Why blockchain, and why MST

MST is the settlement and evidence layer, not a bolt-on. The whole problem is that the platform is one of the interested parties, so a database run by that platform cannot be the referee.

- **Neutral custody of the money.** `TamperSafeEscrow` holds the payment and the bond. No party controls it.
- **Rules fixed in advance.** The oracle can only call defined transitions, so even a compromised relayer cannot send funds to itself.
- **A public audit anchor.** `TelemetryAnchor` stores each box's log head on-chain, so the anchored point cannot be quietly changed.
- **Bond slashing without discretion.** The courier's bond moves by rule, not because a support agent decided.

What the chain does **not** fix: it does not make the sensor honest. It guarantees that once the box reports something, the consequence is automatic and the record is fixed. Trust in the box is a separate problem, covered under [Trust model and limits](#trust-model-and-limits).

**BridgeKey.** The dashboard discovers wallets through EIP-6963 and prefers BridgeKey for connect, network switching and signing. It falls back to any other injected EIP-1193 wallet and shows an install prompt if none is found. BridgeKey publishes no dApp-integration docs, so this uses the standard discovery mechanism rather than a vendor-specific object.

## What is built today

| Capability | Status |
| :--- | :--- |
| Escrow, courier bond, refund and bond slash, expiry | Built and tested (70 contract tests). **Deployed to MST Testnet** |
| Relayer: verified ingest, chain writer, command queue, state-aware rules | Built, tested with the sim-box on a local chain |
| Hash-chained log with head anchored on-chain, and **Verify log** | Anchoring is built. The dashboard compares the relayer's stored head at the anchored sequence with the on-chain head. It does not rebuild the head from raw events, so it trusts the relayer's copy. An independent recompute is roadmap |
| Dashboard: Track, Buyer, Courier, Depot, Evidence | Built on real relayer and chain data, with BridgeKey-first wallet discovery |
| Latch | **Logical in this build.** The box tracks and reports locked/unlocked. The servo actuator was dropped (the motor controller was unreliable) and is roadmap |
| NVS tamper latch, reboot-is-tamper, MPU shock and tilt alerts | Written in firmware and running on the board. Full on-box scenarios with the relayer over Wi-Fi are still being run |
| IR lid tamper rule, RFID delivery key with LED feedback | Written and flashed. On the bench: the right and wrong tags are told apart (3/3 taps each), the LED colors are correct, and the lid state follows a hand over the IR sensor. The full unlock handshake is not yet run end to end. GPS is dropped for the demo (roadmap) |
| An end-to-end order on MST Testnet | **Tamper path verified with the real box** (create, seal, lid lifted, refund and bond slash, anchors: hashes below). The delivery path (Confirm & Unlock, right tag) is not yet run on testnet |

**Not built, and not claimed:** temperature or cold chain, contents or weight detection, on-chain device signatures, cellular connectivity, a production bill of materials.

## Architecture

```
┌─────────────── TamperSafe box ───────────────┐
│ IR lid   MPU6050 shock/tilt   RC522 RFID     │
│ Logical latch   OLED                         │
│ ESP32-S3: state machine, NVS tamper latch,   │
│ hash chain, ring buffer                      │
└───────────────┬──────────────────────────────┘
                │ POST /api/device/events  (JSON + HMAC, every 2 s)
                │ ◀── response carries the pending command (SEAL / UNLOCK / RESET)
┌───────────────▼──────────────────────────┐        ┌──────── dashboard (React) ────────┐
│ relayer (Node + ethers v6)               │──SSE──▶│ Track · Buyer · Courier · Depot · │
│ ingest → verify → log → rules            │◀─REST──│ Evidence                          │
│ chain writer (ORACLE key)                │        └──────┬───────────────▲────────────┘
│ chain listener (UnlockRequested)         │               │ buyer/courier │ reads events
└───────────────┬──────────────────────────┘               │ txs (wallet)  │
                │ ORACLE txs                               ▼               │
┌───────────────▼─────────────────────────────────────────────────────────┴──┐
│ MST Testnet: BoxRegistry · TamperSafeEscrow (holds funds) · TelemetryAnchor │
└─────────────────────────────────────────────────────────────────────────────┘
```

Order lifecycle: `Funded → InTransit → UnlockRequested → Delivered`, or `Tampered`, `Expired`, `Cancelled`. Full contract spec, state machines, wire formats and the hash-chain format are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Contract addresses (MST Testnet)

Chain id 91562037. Read from `deployments/mst-testnet.json`; the relayer and dashboard load addresses and ABIs only from `deployments/`.

| Contract | Address | Deployment |
| :--- | :--- | :--- |
| BoxRegistry | [`0x45fCCe56c139b28655A3b7083f98e41C6c36E04d`](https://testnet.mstscan.com/address/0x45fCCe56c139b28655A3b7083f98e41C6c36E04d) | [deploy tx](https://testnet.mstscan.com/tx/0x3e07dc5011a7d48338aa56d0a848206551d148bce517682c9fdc4edcecef5c0a) |
| TamperSafeEscrow | [`0xC876A0F58592BE567081a752a0Ad53106EFD1223`](https://testnet.mstscan.com/address/0xC876A0F58592BE567081a752a0Ad53106EFD1223) | [deploy tx](https://testnet.mstscan.com/tx/0xb0f20545dd0bc0e863ef9e6108363b960937b0e52c1c9ea95c9cd9eb1003db65) |
| TelemetryAnchor | [`0x6D7Ea16170Bd03685Efad614526d9C38849C9a86`](https://testnet.mstscan.com/address/0x6D7Ea16170Bd03685Efad614526d9C38849C9a86) | [deploy tx](https://testnet.mstscan.com/tx/0x42770e1181c22ae4506353356e76c820332449049d169a0dd9bf9ce47c561b7a) |

Relayer oracle (holds `ORACLE_ROLE`): [`0xD9D03Eb2bf2658E68aEd101621CFc4A055e0BD7a`](https://testnet.mstscan.com/address/0xD9D03Eb2bf2658E68aEd101621CFc4A055e0BD7a)

**Tamper path, run end to end on MST Testnet with the real box (order 2).** Every hash below resolves on the explorer.

| Step | Event | Transaction |
| :--- | :--- | :--- |
| Buyer funds the order | `OrderCreated` | [`0xafd5db9e…`](https://testnet.mstscan.com/tx/0xafd5db9ede5cf61dbcdf0feccf2830afd3ed7d987b1bfba8eb14b660c4406fc0) |
| Relayer seals it into the box, locking the courier bond | `ShipmentSealed` | [`0x6bd4e688…`](https://testnet.mstscan.com/tx/0x6bd4e6880dae945f0cb61314b3cac8590664cdcba17d1f9c1fde8fcb54c020cd) |
| Log head anchored | `Anchored` | [`0x076870a6…`](https://testnet.mstscan.com/tx/0x076870a671cd777aa251231e3f399843550a6887823ee2afd8be755201bdd0bc) |
| Lid lifted: tamper reported, buyer refunded, bond slashed to the seller | `TamperDetected` + 2x `FundsReleased` | [`0x45a70361…`](https://testnet.mstscan.com/tx/0x45a70361d9f0b4d4cb71300df6c34b3c51daf6ab610dcae75b4c81063a34924c) |
| Log head anchored after the tamper | `Anchored` | [`0xf8b8a223…`](https://testnet.mstscan.com/tx/0xf8b8a22365b42f89e7fa9b5c3935557087b859eb34a4b17fbf8f402560c28d08) |

The delivery path (Confirm & Unlock, then the right tag) has not been run on testnet yet, so it is not listed.

## Getting started

Requires Node 22. Run each block from the repo root.

**Contracts** (compile and test)
```bash
cd contracts && npm install && npm test
```

**The whole flow with no hardware and no testnet** (local chain plus the relayer's simulated box)
```bash
cd relayer && npm install
npm run sim -- happy          # also: tamper | power-cycle | offline-gap
```

**Dashboard against a populated local stack**
```bash
cd relayer && ORCHESTRATOR_KEEP_ALIVE=1 npm run sim -- tamper     # leaves the node + relayer up on :4100
cd dashboard && npm install && RELAYER_URL=http://127.0.0.1:4100 npm run dev
```

**Dashboard and relayer on MST Testnet**
1. Create `relayer/.env` from `relayer/.env.example` with `CHAIN=mst`, your own `ORACLE_PRIVATE_KEY` (the account that holds `ORACLE_ROLE`), `BOX_SECRETS` and `PORT=4000`. The file is gitignored; never commit a key.
2. `cd relayer && npm start`
3. `cd dashboard && npm run dev`, open http://localhost:5173, choose **MST**, and connect BridgeKey. The dashboard starts on whichever chain the relayer reports.
4. Get tMSTC from the [MST faucet](https://faucet.masterstroke.academy). The buyer and courier accounts each need some, and the courier's bond must be at least the order amount.

**Firmware** (Arduino IDE: ESP32S3 Dev Module, Flash 16MB, PSRAM OPI, USB CDC On Boot enabled, 115200 baud)
1. Install the `Newrick` library (organiser-provided, copy in `docs/neurick/`), Adafruit SSD1306 + GFX, ArduinoJson and MFRC522.
2. Copy `firmware/tampersafe_box/secrets.example.h` to `secrets.h` and fill in the hotspot, the relayer URL and the box secret (the same value as in `relayer/.env`).
3. Flash `firmware/tampersafe_box`. Wiring and thresholds are in [`docs/HARDWARE.md`](docs/HARDWARE.md).

The demo script, cut-lines and fallback drill are in [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Use cases and business model

Ranked by how well the current box fits, not by market size. Each is analysed in [`pitch.md`](pitch.md) with the sensor that supports it and the gap that is missing.

**Beachhead**
- **High-value e-commerce** (electronics, luxury, collectibles): "box arrived empty" and box-swap claims where one claim costs more than the box.
- **COD-heavy and peer-to-peer marketplaces**: the buyer's money is in escrow before dispatch, so it is prepaid with protection instead of cash on delivery.

**Adjacent, each needing one more capability:** legal and evidence chain of custody, B2B critical spares, sensitive documents, and lab samples (which would need temperature logging, not built).

**Where we would not pitch it:** low-value parcels, perishables, and anything where the tamper that matters happens before the seal.

**Who pays and for what.** Box-as-a-service per shipment or rental, an escrow fee in basis points on high-value orders, a logistics dashboard for couriers and depots, and a dispute-evidence API for marketplaces and insurers. Pricing is unvalidated and stated nowhere because it cannot be sourced. The economics turn on `value per shipment (avoided fraud and dispute cost) > cost per shipment (box amortised over its trips + reverse logistics + connectivity)`. **Reverse logistics is the honest weak spot:** a reusable box has to come back, so the first pilot is a closed lane where boxes return on the same loop.

## Trust model and limits

What this aims to prove: a sealed box's lid was opened, it lost power, or it was shaken hard, and the anchored record of that cannot be quietly altered afterwards. What it does not prove:

| Gap | Why it matters | Mitigation and roadmap |
| :--- | :--- | :--- |
| **The depot seal is the trust point** | A wrong item packed at origin still passes as clean | Weight or photo capture at seal, recorded in the seal transaction |
| **The relayer is a trusted oracle** | It could falsely report tamper | Per-box HMAC, hash-chained log, anchored heads, defined transitions only, no payee choice. Roadmap: device-signed events checked on-chain (`ecrecover` against `BoxRegistry.deviceKey`) |
| **The courier never signs the seal** | The oracle picks whose bond is locked | Courier `acceptShipment` from the courier's wallet |
| **The box secret lives in ESP32 flash** | A skilled attacker with the box could extract it | Secure element (ATECC608) |
| **Physical attacks and jamming** | Any hardware can be defeated with enough effort | Reboot-is-tamper, `SIGNAL_LOST` and `LOG_GAP` alerts. The goal is to make it expensive and evident |
| **Connectivity is a hotspot in the demo** | Silent periods are gaps | Ring buffer and retry. Roadmap: LTE-M or NB-IoT |

## Repository layout

| Folder | What |
| :--- | :--- |
| `contracts/` | Hardhat 3 + OpenZeppelin v5, solc 0.8.24 (`cancun`). Contracts, 70 tests, deploy script |
| `relayer/` | Node 22 + TypeScript. Device ingest with HMAC and hash-chain checks, chain writer, listener, SSE, sim-box |
| `dashboard/` | React + Vite + ethers v6. Track, Buyer, Courier, Depot, Evidence |
| `firmware/` | ESP32-S3 (NEWRRO Neurick) box firmware and bring-up sketches |
| `landing-page/` | Static project page |
| `deployments/` | Addresses, tx hashes and ABIs per chain. The only place contract info is read from |
| `docs/` | Architecture, hardware, implementation plan |
| `pitch.md` | Problem, use cases, business model and limits, in full |

## Open-source libraries

- **Contracts:** Hardhat 3, `@nomicfoundation/hardhat-toolbox-mocha-ethers`, OpenZeppelin Contracts v5.
- **Relayer:** Express, ethers v6, `cors`, `dotenv`, `tsx`, TypeScript, Node's built-in `crypto` and `node:test`.
- **Dashboard:** React, Vite, ethers v6, Leaflet with OpenStreetMap tiles.
- **Firmware:** `Newrick` (organiser-provided), Adafruit SSD1306 + GFX, MFRC522, ESP32 core (WiFi, HTTPClient, Preferences/NVS, mbedtls).
- **Landing page:** vendored GSAP, Lenis, Lottie and Webflow runtime scripts (static assets).

## AI usage

This project uses Claude Code throughout the buildathon: for planning (`docs/`), for scaffolding and writing contracts, firmware, the relayer and the dashboard from the specs in `docs/ARCHITECTURE.md`, and for reviewing diffs against the invariants in `CLAUDE.md`. Every non-trivial block is explained to the team as it lands, and the team signs and runs anything that touches a real key (testnet deploys, the relayer, the faucet, the wallet). No code, contract or firmware was copied from another project.
