import { NETWORKS, type NetworkKey } from "../config/networks";
import type { useWallet } from "../hooks/useWallet";
import { roleOf } from "../config/demo";

export type TabKey = "track" | "buyer" | "courier" | "depot" | "evidence";

const TABS: { key: TabKey; label: string }[] = [
  { key: "track", label: "Track" },
  { key: "buyer", label: "Buyer" },
  { key: "courier", label: "Courier stake" },
  { key: "depot", label: "Depot" },
  { key: "evidence", label: "Evidence" },
];

interface Props {
  tab: TabKey;
  onTab: (t: TabKey) => void;
  networkKey: NetworkKey;
  onNetwork: (k: NetworkKey) => void;
  wallet: ReturnType<typeof useWallet>;
  online: boolean;
  connecting?: boolean;
  relayerChain?: NetworkKey | null;
}

export function Header({ tab, onTab, networkKey, onNetwork, wallet, online, connecting, relayerChain }: Props) {
  const net = NETWORKS[networkKey];
  const wrongChain = wallet.account != null && wallet.chainId != null && wallet.chainId !== net.chainId;

  return (
    <header className="header">
      <span className="brand">TamperSafe</span>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tab${tab === t.key ? " on" : ""}`} onClick={() => onTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="header-right">
        <span className="pill" title={online ? "Receiving from the relayer" : "Relayer not reachable"}>
          <span className={`dot ${online ? "live" : connecting ? "" : "down"}`} />
          {online ? "relayer live" : connecting ? "connecting" : "relayer offline"}
        </span>

        <div className="seg">
          {Object.values(NETWORKS).map((n) => (
            <button key={n.key} className={n.key === networkKey ? "on" : ""} onClick={() => onNetwork(n.key)}>
              {n.key === "local" ? "Local" : "MST"}
            </button>
          ))}
        </div>

        {relayerChain && relayerChain !== networkKey && (
          <span className="pill red" title="The dashboard is reading a different chain than the relayer writes to">
            relayer is on {relayerChain}
          </span>
        )}

        {networkKey === "mst" && !wallet.account && (
          <button className="btn ghost small" onClick={() => void wallet.switchOrAddNetwork(NETWORKS.mst)}>
            Add MST Testnet
          </button>
        )}

        {wallet.account ? (
          wrongChain ? (
            <button className="btn small" onClick={() => void wallet.switchOrAddNetwork(net)}>
              Switch wallet to {net.label}
            </button>
          ) : (
            <span className="pill white mono" title={`Connected with ${wallet.walletName ?? "wallet"}`}>
              {roleOf(wallet.account) ?? wallet.walletName ?? "wallet"} · 
              {wallet.account.slice(0, 6)}…{wallet.account.slice(-4)}
            </span>
          )
        ) : (
          <button className="btn small" onClick={() => void wallet.connect()} disabled={wallet.connecting}>
            {wallet.connecting ? "Connecting…" : `Connect ${wallet.walletName ?? "wallet"}`}
          </button>
        )}
      </div>
      {wallet.error && <div className="error" style={{ width: "100%", margin: 0 }}>{wallet.error}</div>}
    </header>
  );
}
