# TamperSafe: the pitch

> A tamper-evident container that locks itself at origin, watches itself in transit, and settles the payment on-chain by rules fixed before dispatch. A clean delivery pays the seller. Any tamper refunds the buyer and slashes the courier's bond. The box in our demo is one form of it; the product is the protocol behind it (§4).

This document is deliberately blunt. It says what the product does, what it does not do, who would pay, and where it is weakest. Claims about the box match what is in the repo (see §5). Numbers carry a link or are marked `[source needed]`.

---

## 1. The real problem

Every delivery is a three-party deal in which nobody can verify anybody:

| Party | Wants | Cannot prove |
| :--- | :--- | :--- |
| **Buyer** | The thing they paid for, intact | That the box was not opened in transit |
| **Seller** | To be paid | That they shipped the right thing, and that the courier did not swap it |
| **Courier** | To be paid for carrying it | That they did not touch it |

The courier holds the goods and has **nothing at stake**. When something goes wrong, the dispute is one party's word against another's, and it is settled by whoever runs the platform. That has three consequences:

1. **Honest parties lose slowly.** A buyer who got an empty box waits for a claims process. A courier who did nothing wrong is blamed by default.
2. **Dishonest parties win cheaply.** "Item not received", "box was empty" and box-swapping cost the claimant almost nothing to try. Appriss Retail reports that 15.14% of 2024 US returns were fraudulent, $103B in fraudulent returns and claims, on $685B of total returns ([Appriss Retail annual research](https://apprissretail.com/news/appriss-retail-annual-research-fraudulent-returns-and-claims-cost-retailers-103b-in-2024/)). Those are returns, not transit tampering, but it is the same failure: refunds decided on unverifiable claims.
3. **Trust is bought with prepayment, or not at all.** In India, 60 to 65% of e-commerce orders are cash on delivery, and 25 to 30% of COD orders end as return-to-origin, against 2 to 3% of prepaid ones ([Razorpay](https://razorpay.com/blog/cash-on-delivery/); a second blog gives about 26% and under 2%, [Qikink](https://qikink.com/blog/what-is-return-to-origin-how-it-affects-online-businesses/)). These are blog figures, `[primary source needed]`. Sellers pay for that distrust on every failed COD delivery.

Theft in transit is real too. [CargoNet](https://www.cargonet.com/news-and-events/cargonet-in-the-media/2024-theft-trends/) recorded 3,625 US cargo theft incidents in 2024, up 27% on 2023, at an average of $202,364 per theft. Last-mile package theft has no single authoritative dataset; [Security.org](https://www.security.org/package-theft/annual-report/) reports that one in four Americans has had a package stolen at some point. We do not claim a market size from these. They show the problem is not hypothetical.

**The one-sentence problem:** *there is no neutral, evidence-backed way to decide who is at fault when a sealed package arrives wrong, and no consequence for the party who caused it.*

## 2. Why today's fixes fall short

| Fix | What it does | Why it is not enough |
| :--- | :--- | :--- |
| Tamper-evident tape and seals | Shows a seal was broken, afterwards | Evidence is a photo and someone's word. Nothing settles money. Cheap to fake or reseal |
| Standalone GPS trackers | Where the parcel was | Says nothing about whether it was opened. Location is not custody |
| Platform-arbitrated refunds | Decides disputes | The platform is a party with its own incentives. Slow, opaque, and the courier bears no cost |
| Insurance | Pays after a claim | Needs proof of loss, which is exactly what is missing. Premiums price the fraud in |
| Signature on delivery | Confirms someone received it | Proves receipt, not condition |

TamperSafe's difference is that **detection, evidence and settlement are one system**. The box that detects the tamper is the same one whose report moves the money, with rules fixed in advance.

## 3. How it works (four steps)

1. **Seal.** At the depot the servo latch locks the box. The buyer's payment is already in the escrow contract, and the courier's bond is locked against the shipment.
2. **Transit.** The box watches its lid (IR sensor), motion and shock (MPU6050), location (GPS). A tamper is latched in the box's own non-volatile memory. A reboot or power loss mid-transit counts as tamper.
3. **Report.** The box reports over Wi-Fi to a relayer. Every event is hash-chained and authenticated with a per-box secret. The relayer writes the state change to chain and anchors the log head.
4. **Settle.** The buyer confirms at the doorstep and the box unlocks. Clean delivery pays the seller. A tamper refunds the buyer and slashes the courier's bond to the seller.

The invariants that make this more than a demo (all in `CLAUDE.md`):

- Funds move only through the contract's state machine. The relayer triggers defined transitions and **never names a payee**.
- The buyer's own wallet signs create, cancel and unlock. The relayer cannot release funds before the buyer asks.
- Tamper is latched in both the firmware and the contract.
- GPS is evidence only. The venue is indoors, so escrow never depends on a fix, and simulated GPS is always labelled `SIMULATED`.
- Every state change on the dashboard is an on-chain event with an explorer link. Raw telemetry stays off-chain, hash-chained, with the log head anchored on-chain.

## 4. One protocol, many forms

The box is a representation, not the product. What TamperSafe actually is:

```
  sense  ->  latch  ->  report  ->  settle
 (any tamper   (state     (signed,     (escrow rules
  signal)      survives    hash-        fixed before
               a reboot)   chained)     dispatch)
```

None of the four steps depends on the container being a parcel box. The contracts, the relayer, the hash-chained log and the dashboard are form-agnostic. Only the **sensing and latching layer** changes with the form:

| Form | What "sealed" means | Sensing that fits |
| :--- | :--- | :--- |
| Parcel box (built) | Lid latched | Lid IR, shock and tilt, reboot-is-tamper, RFID delivery key |
| Shipping container | Door seal intact | Door-open contact, bolt-seal integrity, shock, location |
| Truck or trailer cargo bay | Rear and side doors closed | Door contacts, cargo-area motion, GPS trail, cellular |
| Pallet or crate | Wrap and strap intact | Strap tension, tilt, shock |
| Cargo aircraft or rail wagon door | Door seal intact | Door contact, dwell-location events |

**What we are claiming, and what we are not:** the settlement and evidence layer transfers unchanged, and that is the hard, valuable part. Each new form still needs its own sensors, a mounting design, power and connectivity, and often certification. Today only the parcel box exists. The reason to think the surface is large is the size of the trade and theft problem (§1), not anything we have measured about demand. We do not put a market number on it.

**Why this matters for the pitch.** A judge who sees a small box may read it as a gadget. The point is that the box proves the loop end to end: a physical event becomes a latched record, becomes an automatic financial consequence, and nobody in the middle can quietly change it.

## 5. What is built today, and what is not

Read this before believing any use case in §6.

| Capability | Status |
| :--- | :--- |
| Escrow, courier bond, refund and bond slash, expiry | Built and tested (70 contract tests). **Deployed to MST testnet** (see the README for addresses and explorer links). An end-to-end order on testnet has not been run yet |
| Relayer: verified ingest, chain writer, command queue, state-aware rules | Built, tested with the sim-box on a local chain |
| Hash-chained log with the head anchored on-chain, and **Verify log** | Anchoring is built. The dashboard button compares the relayer's stored head at the anchored sequence with the on-chain head, and it matches. It does **not** rebuild the head from the raw events, so it trusts the relayer's copy. An independent recompute (browser-side) is roadmap |
| Dashboard: Track, Buyer, Courier, Depot, Evidence | Built on real relayer and chain data. The wallet flows still need a click-through |
| Servo latch (LOCK 180°, UNLOCK 90°) | Calibrated on the hardware. Firmware wired to it |
| NVS tamper latch, reboot-is-tamper, MPU shock and tilt alerts | Written in firmware and compiles. The full on-box scenarios have not run |
| Box to relayer over Wi-Fi | Firmware written. **Never run on hardware yet**: no Wi-Fi credentials are set |
| IR lid sensor and tamper rule | Rule written in the main firmware (4 open samples while sealed latch `LID_OPENED`). The sensor is on CH14. The cover-and-uncover bench test has not been done yet |
| RFID delivery key (RC522) + RGB LED | The buyer signs Confirm & Unlock on-chain, which arms the box (blue). Tapping the enrolled key gives green and opens the latch; any other tag gives red, stays locked and logs evidence alert 17 `AUTH_FAILED`. The key never moves funds. Written and flashed; the reader and LED work on the bench. The full handshake with the relayer has not been run yet. The static tag UID is a demo credential and is cloneable, so production would use a challenge-response (phone NFC or a signed nonce) |
| GPS | **Not yet integrated**: the driver is still a stub. It will be evidence only and report `NO_FIX` indoors |
| Runs without hardware (sim-box) and without testnet (`CHAIN=local`) | Built. This is the fallback if the box misbehaves on stage |

**Not built. Do not claim:**

- Temperature or cold chain. There is no sensor and no field for it.
- Contents or weight detection. The ultrasonic sensor was dropped, and `CONTENTS_DISTURBED` is a legacy code.
- On-chain device signatures. `deviceKey` is unset today. The relayer is a trusted oracle (§9).
- Cellular connectivity. The demo box uses Wi-Fi only.
- A production bill of materials. The Neurick board is an organiser-supplied dev kit.

## 6. Use cases, ranked

Ranked by how well the current box fits, not by market size. Each one names what supports it and what is missing.

### Tier 1: beachhead

**1. High-value e-commerce (electronics, luxury, collectibles).**
- *Pain:* "box arrived empty" and box-swap claims on a few expensive items, where one claim costs more than the box.
- *Fit:* lid tamper, reboot-as-tamper, shock, and a hash-chained evidence trail that ends the argument. The bond gives the courier a reason to behave.
- *Gap:* the depot seal is the trust point (§9). A weight or photo check at seal would close it.

**2. COD-heavy and peer-to-peer marketplace trust (India and similar).**
- *Pain:* buyers will not prepay a stranger, sellers eat failed COD deliveries.
- *Fit:* the buyer's money is in escrow before dispatch, so the seller knows the buyer is funded, and the buyer knows the money moves only on their confirmation or a tamper. This is prepaid-with-protection, not COD.
- *Gap:* needs a wallet or a fiat on-ramp. Wallet UX is the adoption cost here, not the hardware.

### Tier 2: adjacent, needs one more capability each

**3. Legal and evidence chain of custody.** Tamper-evident, timestamped custody with an audit trail nobody controls. *Gap:* stronger identity for who opened it and when (device-signed events, roadmap).

**4. Lab samples and clinical trial materials.** Custody matters. *Gap:* these usually need temperature logging, which is not built. Without it this is not a fit.

**5. B2B critical spares and high-value parts.** Same escrow-plus-tamper logic between businesses with a reusable box. *Gap:* longer routes need LTE-M, not Wi-Fi.

**6. Sensitive documents and cash-like items** (contracts, tenders, deeds). Lid tamper is the whole product. Lowest hardware need.

### Tier 3: long tail (one line each, unvalidated)

- Pharmacy and prescription delivery (needs cold chain for many items).
- Art and antiques in transit.
- Election and ballot custody.
- Evidence and forensic exhibits handed between agencies.
- Warranty and repair returns, to stop parts being swapped in the return box.

**Where we would not pitch it:** low-value parcels, since a box costs more than the fraud. Perishables, since there is no cold chain. Anything where the tamper that matters happens before the seal.

## 7. Business model

We have not validated pricing. This section names who pays and for what, and shows where the economics are decided. No prices are stated because we cannot source them.

| Revenue line | Who pays | For what |
| :--- | :--- | :--- |
| **Box-as-a-service** (per shipment or monthly rental) | Seller or logistics firm | The reusable smart box, latch, sensors and connectivity |
| **Escrow fee** (basis points of order value) | Buyer or seller | Neutral settlement. A fee only makes sense on high-value orders |
| **Logistics dashboard (SaaS)** | Couriers and depot operators | Fleet view, bond management, tamper analytics |
| **Dispute-evidence API** | Marketplaces and insurers | A verifiable custody record in place of photos and testimony |

**Where it is decided, the unit economics:**

```
cost per shipment  =  (box cost / trips per box life)
                    + reverse logistics (getting the empty box back)
                    + connectivity + relayer/gas + handling
value per shipment =  avoided fraud loss + avoided dispute handling
                    + conversion gain from prepaid-with-protection
```

It works only when `value > cost`, which means **high-value goods and high fraud or dispute rates**. This is why Tier 1 is electronics and luxury, not groceries.

**The honest weak spot is reverse logistics.** A reusable box has to come back. If the return leg costs more than it saves, the model fails. Mitigations to test in a pilot: dedicated routes where boxes return in the same trip, depot-to-depot loops, and B2B lanes where the box shuttles between two known sites.

## 8. Why blockchain, and why not just a database

The question MST judges will ask.

**What the chain adds**
- **Neutral custody of the money.** The escrow is a contract no party controls. Not the platform, not the seller, not the courier.
- **Rules fixed in advance.** The relayer can trigger only defined transitions and never chooses a payee. Even a compromised relayer cannot send funds to itself.
- **A public audit anchor.** The device log head is anchored on-chain, so the anchored point cannot be quietly changed. Anyone holding the raw log can recompute the chain and compare it with the anchor. Today the dashboard's Verify log compares the relayer's own stored head, so the independent recompute is roadmap.
- **Bond slashing without discretion.** The courier's bond moves by rule, not because a support agent decided.

**"Why not a database?"** A database works if everyone trusts whoever runs it. Our whole problem is that the platform is one of the interested parties. A database can be edited by its operator after the fact. An on-chain state machine and an anchored log cannot be, at least not silently.

**What the chain does not fix.** It does not make the sensor honest. The chain only guarantees that once the box says something, the consequence is automatic and the record is fixed. Trust in the box is a separate problem (§9).

## 9. Trust and threat model

What this proves, and what it does not.

**It aims to prove:** a sealed box's lid was opened, it lost power, or it was shaken hard, and that the anchored record of it cannot be quietly altered afterwards. Once the IR rule and on-box scenarios land, this is what the demo shows. It is not fully demonstrated on hardware yet (§5).

**It does not prove:**

| Gap | Why it matters | Mitigation |
| :--- | :--- | :--- |
| **The depot seal is the trust point.** A brick packed at origin still passes as "clean" | A dishonest seller can ship the wrong thing in a perfectly tamper-free box | Roadmap: weight or photo capture at seal, recorded in the seal transaction. Also seller reputation |
| **The relayer is a trusted oracle** and could falsely report tamper | It holds `ORACLE_ROLE` | Per-box HMAC, hash-chained log, anchored heads, defined transitions only, no payee choice. Roadmap: device-signed events checked on-chain (`ecrecover` against `BoxRegistry.deviceKey`), which makes the relayer a gas payer only |
| **The courier never signs the seal** | The oracle picks whose bond is locked | Roadmap: courier `acceptShipment` from the courier's wallet |
| **The box secret lives in ESP32 flash** | A skilled attacker with the box could extract it | Roadmap: secure element (ATECC608) |
| **Physical attacks on the box** (cut the case, defeat the sensor, jam Wi-Fi) | Any hardware can be defeated by enough effort | Reboot-is-tamper, signal-lost alerts, and tamper latched in the box. The goal is to make it expensive and evident, not impossible |
| **Connectivity** is a hotspot in the demo | Silent periods are gaps | Ring buffer and retry, `SIGNAL_LOST` and `LOG_GAP` alerts. Roadmap: LTE-M or NB-IoT |

## 10. Objections and honest answers

| Objection | Answer |
| :--- | :--- |
| "A box for every parcel is absurd." | Agreed. This is for high-value goods and dedicated lanes, not the general parcel flow (§6, §7). |
| "What if the goods were wrong before sealing?" | Then we do not catch it today. It is the largest gap, and the fix is a weight or photo check at seal. |
| "Cost per shipment?" | We cannot source it and will not invent it. §7 shows the formula. A pilot is how we find the number. |
| "GPS does not work indoors." | Correct, so escrow never depends on it. GPS is evidence, shown as `NO_FIX` when there is none. |
| "Battery and range?" | The demo runs on a 12 V pack and Wi-Fi. A production box needs low-power design and cellular. Not built. |
| "Why would couriers accept a bond?" | Honest couriers gain: they are no longer blamed by default, and a clean record is proven. Adoption depends on incentives such as better rates or priority lanes. Untested. |
| "Wallets are a hurdle." | True for Tier 1's consumer side. Fiat on-ramps and account abstraction are the answer, and are not built. Marketplaces could hide the wallet entirely. |
| "Isn't this just tamper tape plus GPS?" | Tape and GPS produce evidence a human argues over. Here the evidence and the money are the same system (§2). |
| "What stops the relayer cheating?" | It cannot choose a payee and cannot release before the buyer asks. It can still falsely report tamper. That is the known gap, and device-signed attestations are the fix. |

## 11. Go-to-market and pilot

1. **Design partner, not a launch.** One seller or marketplace with high-value shipments and a known dispute rate.
2. **One closed lane.** Depot to a small set of customers, boxes that return in the same loop. This isolates the reverse-logistics question.
3. **Measure three things:** disputes per hundred shipments with and without the box, cost per shipment including the return leg, and how many disputes the evidence record resolved without escalation.
4. **Decide from the numbers.** If `value < cost`, narrow to a higher-value tier. If it works, add LTE-M and device signatures before scaling.

**Build order after the buildathon:** device-signed events, courier-signed seal, weight or photo at seal, cellular, secure element. In that order, because the first two remove the two largest trust gaps in §9.

## 12. See it

- Demo script and cut-lines: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- Design and trust model: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §3
- Wiring and thresholds: [`docs/HARDWARE.md`](docs/HARDWARE.md)
- The local fallback: `CHAIN=local` with the relayer's sim-box runs the full flow with no hardware and no testnet.

### Sources

Each figure above was checked against the linked page.

- [Appriss Retail annual research, 2024](https://apprissretail.com/news/appriss-retail-annual-research-fraudulent-returns-and-claims-cost-retailers-103b-in-2024/): 15.14%, $103B, $685B
- [CargoNet, 2024 theft trends](https://www.cargonet.com/news-and-events/cargonet-in-the-media/2024-theft-trends/): 3,625 incidents, +27%, $202,364 average
- [Security.org, package theft report](https://www.security.org/package-theft/annual-report/): one in four Americans, lifetime
- India COD and RTO (blog sources, `[primary source needed]`): [Razorpay](https://razorpay.com/blog/cash-on-delivery/) (60 to 65% COD, citing ET Prime Research; COD RTO 25 to 30%; prepaid 2 to 3%), [Qikink](https://qikink.com/blog/what-is-return-to-origin-how-it-affects-online-businesses/) (about 26% COD, under 2% prepaid)
