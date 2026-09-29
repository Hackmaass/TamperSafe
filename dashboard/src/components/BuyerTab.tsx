import { useCallback, useEffect, useMemo, useState } from "react";
import { Interface, isAddress, parseEther, ZeroAddress } from "ethers";
import type { NetworkConfig } from "../config/networks";
import type { useWallet } from "../hooks/useWallet";
import { useTxRunner } from "../hooks/useTxRunner";
import {
  getEscrowContract,
  getReadProvider,
  statusLabel,
  toOnChainOrder,
  type OnChainOrder,
} from "../lib/contracts";
import { getAbi } from "../lib/deployments";
import {
  datetimeLocalToUnixSeconds,
  decodeContractError,
  degreesToMicrodegrees,
  formatTMSTC,
  microdegreesToDegrees,
} from "../lib/format";
import { TxList } from "./TxList";
import { DEMO, defaultDeadline, roleOf } from "../config/demo";
import { Empty, Panel, Pill } from "./ui";

interface Props {
  network: NetworkConfig;
  wallet: ReturnType<typeof useWallet>;
}

interface OrderRow {
  id: bigint;
  order: OnChainOrder;
}

// §4: where the order amount ends up once a terminal state is reached.
// Non-terminal states (Funded, InTransit, UnlockRequested) have no payout yet.
function moneyWentTo(order: OnChainOrder): string {
  switch (order.status) {
    case 4: // Delivered
      return `seller (${order.seller.slice(0, 6)}…)`;
    case 5: // Tampered
    case 6: // Expired
    case 7: // Cancelled
      return `buyer (refunded)`;
    default:
      return "— (in escrow)";
  }
}

export function BuyerTab({ network, wallet }: Props) {
  const escrowInterface = useMemo(() => new Interface(getAbi("TamperSafeEscrow")), []);
  const { entries, run } = useTxRunner();

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  useEffect(() => {
    if (!wallet.account) {
      setOrders([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const escrow = getEscrowContract(network, getReadProvider(network));
        const count = (await escrow.orderCount()) as bigint;
        const rows: OrderRow[] = [];
        // Order ids start at 1 (ARCHITECTURE.md §5.1: "activeOrderId == 0
        // means free"). We iterate 1..orderCount() inclusive, which is
        // correct whether orderCount() means "how many orders exist" or
        // "the last assigned id" — both cases enumerate every real order.
        for (let id = 1n; id <= count; id++) {
          const raw = await escrow.getOrder(id);
          const order = toOnChainOrder(raw);
          if (order.buyer.toLowerCase() === wallet.account!.toLowerCase()) {
            rows.push({ id, order });
          }
        }
        if (!cancelled) setOrders(rows);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [network, wallet.account, refreshTick]);

  const ensureWalletOnNetwork = useCallback(async () => {
    if (wallet.chainId !== network.chainId) {
      await wallet.switchOrAddNetwork(network);
    }
  }, [network, wallet]);

  // --- Create order form state ---
  const [seller, setSeller] = useState<string>(DEMO.seller);
  const [amount, setAmount] = useState<string>(DEMO.amount);
  const [lat, setLat] = useState<string>(DEMO.destLat);
  const [lon, setLon] = useState<string>(DEMO.destLon);
  const [deadlineLocal, setDeadlineLocal] = useState(defaultDeadline);
  const [formError, setFormError] = useState<string | null>(null);

  const submitCreateOrder = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      if (!wallet.account) {
        setFormError("Connect a wallet first.");
        return;
      }
      if (!isAddress(seller)) {
        setFormError("Seller must be a valid address.");
        return;
      }
      if (seller.toLowerCase() === wallet.account.toLowerCase()) {
        setFormError("Seller cannot be the connected (buyer) address (InvalidSeller).");
        return;
      }
      const amountNum = Number(amount);
      if (!(amountNum > 0)) {
        setFormError("Amount must be greater than 0 (ZeroAmount).");
        return;
      }
      const latNum = Number(lat);
      const lonNum = Number(lon);
      if (!(latNum >= -90 && latNum <= 90)) {
        setFormError("Latitude must be between -90 and 90.");
        return;
      }
      if (!(lonNum >= -180 && lonNum <= 180)) {
        setFormError("Longitude must be between -180 and 180.");
        return;
      }
      if (!deadlineLocal) {
        setFormError("Pick a deadline.");
        return;
      }
      const deadlineSec = datetimeLocalToUnixSeconds(deadlineLocal);
      if (deadlineSec <= Math.floor(Date.now() / 1000)) {
        setFormError("Deadline must be in the future (BadDeadline).");
        return;
      }

      try {
        await ensureWalletOnNetwork();
        await run(
          `createOrder(${seller.slice(0, 8)}…, ${amount} tMSTC)`,
          async () => {
            const signer = await wallet.getSigner();
            const escrow = getEscrowContract(network, signer);
            return escrow.createOrder(
              seller,
              degreesToMicrodegrees(latNum),
              degreesToMicrodegrees(lonNum),
              BigInt(deadlineSec),
              { value: parseEther(amount) },
            );
          },
          (err) => decodeContractError(err, escrowInterface),
        );
        refresh();
      } catch {
        // Surfaced via the tx list already.
      }
    },
    [amount, deadlineLocal, ensureWalletOnNetwork, escrowInterface, lat, lon, network, refresh, run, seller, wallet],
  );

  const cancelOrder = useCallback(
    async (id: bigint) => {
      try {
        await ensureWalletOnNetwork();
        await run(
          `cancelOrder(${id})`,
          async () => {
            const signer = await wallet.getSigner();
            const escrow = getEscrowContract(network, signer);
            return escrow.cancelOrder(id);
          },
          (err) => decodeContractError(err, escrowInterface),
        );
        refresh();
      } catch {
        // Surfaced via the tx list already.
      }
    },
    [ensureWalletOnNetwork, escrowInterface, network, refresh, run, wallet],
  );

  const confirmAndUnlock = useCallback(
    async (id: bigint) => {
      try {
        await ensureWalletOnNetwork();
        await run(
          `requestUnlock(${id})`,
          async () => {
            const signer = await wallet.getSigner();
            const escrow = getEscrowContract(network, signer);
            return escrow.requestUnlock(id);
          },
          (err) => decodeContractError(err, escrowInterface),
        );
        refresh();
      } catch {
        // Surfaced via the tx list already.
      }
    },
    [ensureWalletOnNetwork, escrowInterface, network, refresh, run, wallet],
  );

  if (!wallet.account) {
    return <Empty>Connect a wallet to create and manage orders.</Empty>;
  }
  const wrongAccount = wallet.account.toLowerCase() !== DEMO.buyer.toLowerCase();

  return (
    <div className="stack">
      {wrongAccount && (
        <Panel title="Wrong account">
          <p className="error" style={{ margin: 0 }}>
            You are connected as <b>{roleOf(wallet.account) ?? "an unknown account"}</b> ({wallet.account.slice(0, 8)}…). Orders must be created by the
            buyer. In BridgeKey, switch to the buyer account <span className="mono">{DEMO.buyer}</span>, refresh this page, and connect again.
          </p>
        </Panel>
      )}
      <Panel title="New order">
        <form className="form row" onSubmit={submitCreateOrder}>
          <label className="field">
            <span>Seller address</span>
            <input value={seller} onChange={(e) => setSeller(e.target.value)} placeholder="0x…" />
          </label>
          <label className="field">
            <span>Amount (tMSTC)</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.01" />
          </label>
          <label className="field">
            <span>Destination lat</span>
            <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="12.9716" />
          </label>
          <label className="field">
            <span>Destination lon</span>
            <input value={lon} onChange={(e) => setLon(e.target.value)} placeholder="77.5946" />
          </label>
          <label className="field">
            <span>Deadline</span>
            <input type="datetime-local" value={deadlineLocal} onChange={(e) => setDeadlineLocal(e.target.value)} />
          </label>
          <button className="btn" type="submit" disabled={wrongAccount} title={wrongAccount ? "Switch to the buyer account first" : undefined}>
            Create and fund
          </button>
        </form>
        {formError && <p className="error">{formError}</p>}
      </Panel>

      <Panel title="My orders">
        {loading && <span className="muted">Loading…</span>}
        {loadError && <p className="error">{loadError}</p>}
        {!loading && !loadError && orders.length === 0 && <span className="muted">No orders yet.</span>}
        {orders.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Seller</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Money</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orders.map(({ id, order }) => (
                  <tr key={id.toString()}>
                    <td className="mono">#{id.toString()}</td>
                    <td className="mono">{order.seller === ZeroAddress ? "—" : `${order.seller.slice(0, 6)}…${order.seller.slice(-4)}`}</td>
                    <td>{formatTMSTC(order.amount)}</td>
                    <td>
                      <Pill tone={order.status === 5 ? "red" : order.status === 4 ? "white" : undefined}>{statusLabel(order.status)}</Pill>
                    </td>
                    <td className="muted">{moneyWentTo(order)}</td>
                    <td className="actions">
                      <button className="btn ghost small" disabled={order.status !== 1} onClick={() => void cancelOrder(id)}>
                        Cancel
                      </button>
                      <button className="btn small" disabled={order.status !== 2} onClick={() => void confirmAndUnlock(id)}>
                        Confirm and unlock
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {orders.some(({ order }) => order.status === 3) && (
        <Panel title="Next: tap your delivery key">
          <p className="muted" style={{ margin: 0 }}>
            You confirmed on-chain. Tap your delivery key on the box to open it. A wrong key keeps it locked and is logged as evidence.
          </p>
        </Panel>
      )}

      {entries.length > 0 && (
        <Panel title="Your transactions">
          <TxList entries={entries} />
        </Panel>
      )}
    </div>
  );
}
