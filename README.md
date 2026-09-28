# TamperSafe

A tamper-evident delivery box with on-chain escrow, built for the MST Blockchain x NEWRRO 24-Hour Buildathon.

The buyer's payment sits in an escrow contract on **MST Testnet** from dispatch to doorstep. The box locks itself at the depot, watches its lid, motion, location and package identity in transit, and reports to a relayer that writes state changes to chain. A clean delivery pays the seller. Any tamper refunds the buyer and slashes the courier's bond to the seller. The problem, use cases and honest limits are in [`pitch.md`](pitch.md).

## How MST Blockchain is used

MST is the settlement and evidence layer, not a bolt-on. Without it there is nobody neutral to hold the money or the record.

- **`TamperSafeEscrow`** holds the buyer's payment and the courier's bond and moves them through a fixed state machine (Funded, InTransit, UnlockRequested, Delivered, Tampered, Expired, Cancelled). The relayer holds `ORACLE_ROLE` and can only trigger defined transitions; it never names a payee. The buyer's own wallet signs create, cancel and unlock.
- **`BoxRegistry`** registers each physical box and binds it to at most one active order.
- **`TelemetryAnchor`** stores the head of each box's hash-chained event log on-chain and logs evidence-only alerts.
- Every state change the dashboard shows is a contract event with an explorer link. Raw telemetry stays off-chain and is hash-chained, with the log head anchored on-chain.
- **Wallet: BridgeKey.** The dashboard discovers wallets through EIP-6963 and prefers [BridgeKey](https://bridgekey.io), the official MST wallet, for connect, network switching and signing. It falls back to any other injected EIP-1193 wallet, and shows an install prompt if none is found. BridgeKey publishes no dApp-integration docs, so this uses the standard discovery mechanism rather than a vendor-specific object.

## Contract addresses (MST Testnet, chain id 91562037)

Read from `deployments/mst-testnet.json`; the relayer and dashboard load addresses and ABIs only from `deployments/`.

| Contract | Address | Deployment |
| :--- | :--- | :--- |
| BoxRegistry | [`0x45fCCe56c139b28655A3b7083f98e41C6c36E04d`](https://testnet.mstscan.com/address/0x45fCCe56c139b28655A3b7083f98e41C6c36E04d) | [deploy tx](https://testnet.mstscan.com/tx/0x3e07dc5011a7d48338aa56d0a848206551d148bce517682c9fdc4edcecef5c0a) |
| TamperSafeEscrow | [`0xC876A0F58592BE567081a752a0Ad53106EFD1223`](https://testnet.mstscan.com/address/0xC876A0F58592BE567081a752a0Ad53106EFD1223) | [deploy tx](https://testnet.mstscan.com/tx/0xb0f20545dd0bc0e863ef9e6108363b960937b0e52c1c9ea95c9cd9eb1003db65) |
| TelemetryAnchor | [`0x6D7Ea16170Bd03685Efad614526d9C38849C9a86`](https://testnet.mstscan.com/address/0x6D7Ea16170Bd03685Efad614526d9C38849C9a86) | [deploy tx](https://testnet.mstscan.com/tx/0x42770e1181c22ae4506353356e76c820332449049d169a0dd9bf9ce47c561b7a) |

Relayer oracle (holds `ORACLE_ROLE`): [`0xD9D03Eb2bf2658E68aEd101621CFc4A055e0BD7a`](https://testnet.mstscan.com/address/0xD9D03Eb2bf2658E68aEd101621CFc4A055e0BD7a)

**Transaction hashes for the settlement flow (create, seal, tamper or delivery, anchor):** to be listed here after the end-to-end run on testnet. Only real, explorer-resolvable hashes go in this table.

## Repository layout

| Folder | What |
| :--- | :--- |
| `contracts/` | Hardhat 3 + OpenZeppelin v5, solc 0.8.24 (`cancun`). Contracts, 68 tests, deploy script |
| `relayer/` | Node 22 + TypeScript. Device ingest with HMAC and hash-chain checks, chain writer, listener, SSE, sim-box |
| `dashboard/` | React + Vite + ethers v6. Track, Buyer, Courier, Depot, Evidence |
| `firmware/` | ESP32-S3 (NEWRRO Neurick) box firmware and bring-up sketches |
| `landing-page/` | Static project page |
| `deployments/` | Addresses, tx hashes and ABIs per chain. The only place contract info is read from |
| `docs/` | Architecture, hardware, implementation plan |

## Setup and run

Requires Node 22. Run each block from the repo root.

**Contracts** (compile and test)
```
cd contracts && npm install && npm test
```

**Run the whole flow with no hardware and no testnet** (local chain plus the relayer's simulated box)
```
cd relayer && npm install
npm run sim -- happy          # also: tamper | power-cycle | offline-gap
```

**Dashboard against a populated local stack**
```
cd relayer && ORCHESTRATOR_KEEP_ALIVE=1 npm run sim -- tamper     # leaves the node + relayer up on :4100
cd dashboard && npm install && RELAYER_URL=http://127.0.0.1:4100 npm run dev
```

**Dashboard and relayer on MST Testnet**
1. Create `relayer/.env` from `relayer/.env.example` with `CHAIN=mst`, your own `ORACLE_PRIVATE_KEY` (the oracle account that holds `ORACLE_ROLE`), `BOX_SECRETS` and `PORT=4000`. This file is gitignored; never commit a key.
2. `cd relayer && npm start`
3. `cd dashboard && npm run dev`, open http://localhost:5173, choose **MST**, and connect BridgeKey. The dashboard starts on whichever chain the relayer reports.
4. Get tMSTC from the MST faucet (https://faucet.masterstroke.academy). The buyer and courier accounts each need some. The courier's bond must be at least the order amount.

**Firmware** (Arduino IDE settings: ESP32S3 Dev Module, Flash 16MB, PSRAM OPI, USB CDC On Boot enabled, 115200 baud)
1. Install the `Newrick` library (organiser-provided, copy in `docs/neurick/`), Adafruit SSD1306 + GFX, ArduinoJson, MFRC522, TinyGPSPlus.
2. Copy `firmware/tampersafe_box/secrets.example.h` to `secrets.h` and fill in the hotspot, the relayer URL and the box secret (the same value as in `relayer/.env`).
3. Flash `firmware/tampersafe_box`. The 12 V battery must be on for the servo. Wiring is in `docs/HARDWARE.md`.

## Status

See [`pitch.md`](pitch.md) section 5 for the capability-by-capability status. In short:

- Working and tested: contracts, relayer, dashboard, and the full flow on a local chain with the simulated box.
- Deployed: all three contracts on MST Testnet.
- Firmware: drivers for the IR lid rule, RFID package watch and GPS are written and run on the board. The on-box scenarios with the relayer over Wi-Fi are still being run, so the physical box is not yet demonstrated end to end.

## Open-source libraries

- **Contracts:** Hardhat 3, `@nomicfoundation/hardhat-toolbox-mocha-ethers`, OpenZeppelin Contracts v5.
- **Relayer:** Express, ethers v6, `cors`, `dotenv`, `tsx`, TypeScript, Node's built-in `crypto` and `node:test`.
- **Dashboard:** React, Vite, ethers v6, Leaflet with OpenStreetMap tiles.
- **Firmware:** `Newrick` (organiser-provided), Adafruit SSD1306 + GFX, MFRC522, TinyGPSPlus, ESP32 core (WiFi, HTTPClient, Preferences/NVS, mbedtls).
- **Landing page:** vendored GSAP, Lenis, Lottie and Webflow runtime scripts (static assets).

## AI usage note

This project uses Claude Code throughout the buildathon: for planning (`docs/`), for scaffolding and writing contracts, firmware, the relayer and the dashboard from the specs in `docs/ARCHITECTURE.md`, and for reviewing diffs against the invariants in `CLAUDE.md`. Every non-trivial block is explained to the team as it lands, and the team signs and runs anything that touches a real key (testnet deploys, the relayer, the faucet, the wallet). No code, contract or firmware was copied from another project.

## Known limitations and production path

See `docs/ARCHITECTURE.md` §3 (trust model) and `pitch.md` sections 5 and 9. The largest gaps: the relayer is a trusted oracle, the depot seal is the trust point, and Verify log compares the relayer's own stored head rather than recomputing it independently.
