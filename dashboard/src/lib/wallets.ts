// Wallet discovery. BridgeKey is MST's official wallet and the one we prefer,
// but BridgeKey publishes no dApp-integration docs, so we do not assume a
// vendor-specific object. Any EIP-1193 wallet announces itself through
// EIP-6963; we pick BridgeKey from those announcements when it is there and
// fall back to the legacy `window.ethereum` for wallets that predate it.
import type { Eip1193Provider } from "ethers";

export interface InjectedProvider extends Eip1193Provider {
  isBridgeKey?: boolean;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

export interface Wallet {
  name: string;
  rdns: string;
  provider: InjectedProvider;
}

interface AnnounceDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: InjectedProvider;
}

declare global {
  interface Window {
    ethereum?: InjectedProvider;
  }
}

const isBridgeKey = (w: Pick<Wallet, "name" | "rdns">) => /bridge\s*key/i.test(`${w.name} ${w.rdns}`);

/** Collects EIP-6963 announcements for a short window, then adds the legacy
 * `window.ethereum` if no announced wallet already wraps it. */
export function discoverWallets(windowMs = 250): Promise<Wallet[]> {
  return new Promise((resolve) => {
    const found = new Map<string, Wallet>();
    const onAnnounce = (e: Event) => {
      const { info, provider } = (e as CustomEvent<AnnounceDetail>).detail;
      found.set(info.uuid, { name: info.name, rdns: info.rdns, provider });
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const list = [...found.values()];
      const legacy = window.ethereum;
      if (legacy && !list.some((w) => w.provider === legacy)) {
        list.push({ name: legacy.isBridgeKey ? "BridgeKey" : "Browser wallet", rdns: "", provider: legacy });
      }
      resolve(list);
    }, windowMs);
  });
}

/** BridgeKey when present, otherwise the first wallet found. */
export function pickWallet(wallets: Wallet[]): Wallet | null {
  return wallets.find(isBridgeKey) ?? wallets[0] ?? null;
}
