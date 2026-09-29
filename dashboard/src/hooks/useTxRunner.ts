import { useCallback, useState } from "react";
import type { ContractTransactionResponse } from "ethers";
import { explorerTxUrl, networkByChainId, type NetworkConfig } from "../config/networks";
import { getReadProvider } from "../lib/contracts";

export interface TxEntry {
  id: string;
  label: string;
  status: "pending" | "confirmed" | "failed";
  hash?: string;
  explorerUrl?: string | null;
  error?: string;
}

/**
 * Tracks pending/confirmed/failed status for buyer/courier-signed txs and
 * builds the explorer link. The link is built from the **wallet's actual
 * chain at send time**, not the dashboard's network dropdown — if those
 * ever disagree (e.g. dropdown says mst but MetaMask is still on Hardhat),
 * linking off the dropdown would produce a dead mstscan.com link for a
 * local tx hash, which ARCHITECTURE.md §10 explicitly forbids.
 */
/** Poll for the receipt through our own read RPC. The wallet's provider (BridgeKey) is
 * rate-limited and answers 429 while a transaction that DID mine is still pending, which
 * used to show as a failure. Errors while polling are treated as blips. */
async function waitForReceipt(tx: ContractTransactionResponse, network: NetworkConfig | undefined) {
  if (!network) return tx.wait();
  const provider = getReadProvider(network);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (receipt) return receipt;
    } catch {
      // rate limit or network blip: keep polling
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error("Timed out waiting for the transaction to be mined");
}

export function useTxRunner() {
  const [entries, setEntries] = useState<TxEntry[]>([]);

  const run = useCallback(
    async (
      label: string,
      send: () => Promise<ContractTransactionResponse>,
      decodeError?: (err: unknown) => string,
    ) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setEntries((prev) => [{ id, label, status: "pending" }, ...prev]);
      try {
        const tx = await send();
        let explorerUrl: string | null = null;
        let actualNetwork: NetworkConfig | undefined;
        try {
          const net = await tx.provider.getNetwork();
          actualNetwork = networkByChainId(Number(net.chainId));
          if (actualNetwork) explorerUrl = explorerTxUrl(actualNetwork, tx.hash);
        } catch {
          // best-effort only; missing link is not fatal
        }
        setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, hash: tx.hash, explorerUrl } : e)));

        const receipt = await waitForReceipt(tx, actualNetwork);
        if (receipt && receipt.status === 1) {
          setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, status: "confirmed" } : e)));
          return receipt;
        }
        throw new Error("Transaction reverted");
      } catch (err) {
        console.error("[tx failed]", label, err);
        const message = decodeError ? decodeError(err) : err instanceof Error ? err.message : String(err);
        setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, status: "failed", error: message } : e)));
        throw err;
      }
    },
    [],
  );

  return { entries, run };
}
