import { useEffect, useState } from "react";
import { DEFAULT_NETWORK, NETWORKS, type NetworkKey } from "./config/networks";
import { useWallet } from "./hooks/useWallet";
import { useRelayer } from "./hooks/useRelayer";
import { Header, type TabKey } from "./components/Header";
import { TrackTab } from "./components/TrackTab";
import { BuyerTab } from "./components/BuyerTab";
import { CourierTab } from "./components/CourierTab";
import { DepotTab } from "./components/DepotTab";
import { EvidenceTab } from "./components/EvidenceTab";

export function App() {
  const wallet = useWallet();
  const relayer = useRelayer();
  const [networkKey, setNetworkKey] = useState<NetworkKey>(DEFAULT_NETWORK);
  // The tab lives in the URL hash so a view can be linked or refreshed.
  const [tab, setTabState] = useState<TabKey>(() => {
    const h = window.location.hash.slice(1);
    return (["track", "buyer", "courier", "depot", "evidence"] as const).find((t) => t === h) ?? "track";
  });
  const setTab = (t: TabKey) => {
    window.location.hash = t;
    setTabState(t);
  };
  const network = NETWORKS[networkKey];

  // The relayer knows which chain it writes to; start on that one so a fresh
  // page never reads a different chain than the box is settling on.
  const relayerChain = relayer.chain;
  useEffect(() => {
    if (relayerChain) setNetworkKey(relayerChain);
  }, [relayerChain]);

  return (
    <>
      <Header tab={tab} onTab={setTab} networkKey={networkKey} onNetwork={setNetworkKey} wallet={wallet} online={relayer.online} connecting={relayer.connecting} relayerChain={relayer.chain} />
      <main className="page">
        {tab === "track" && <TrackTab relayer={relayer} />}
        {tab === "buyer" && <BuyerTab network={network} wallet={wallet} />}
        {tab === "courier" && <CourierTab network={network} wallet={wallet} />}
        {tab === "depot" && <DepotTab relayer={relayer} account={wallet.account} />}
        {tab === "evidence" && <EvidenceTab network={network} relayer={relayer} />}
      </main>
    </>
  );
}

export default App;
