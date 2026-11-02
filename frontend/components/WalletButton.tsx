"use client";
import { useCallback, useEffect, useState } from "react";
import { usePoll, type Overview } from "@/lib/api";
import { short } from "@/lib/format";

type Eth = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (ev: string, fn: (...a: unknown[]) => void) => void;
  removeListener?: (ev: string, fn: (...a: unknown[]) => void) => void;
};
const eth = (): Eth | undefined => (typeof window === "undefined" ? undefined : (window as unknown as { ethereum?: Eth }).ethereum);

const hex = (n: number) => "0x" + n.toString(16);
const fmt = (raw: bigint, dec: number, digits = 4) => {
  const s = raw.toString().padStart(dec + 1, "0");
  const whole = s.slice(0, -dec) || "0";
  const frac = s.slice(-dec).slice(0, digits).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
};

/**
 * Read-only wallet connection (EIP-1193, no extra deps). It shows the connected address and its HSK and dUSDC
 * balances on the Sealed chain. Signing stays server-side: the Vault holds the mandate keys by design, so the
 * browser wallet is an identity and balance view, not a signer for seal/spend.
 */
export function WalletButton() {
  const { data: o } = usePoll<Overview>("/api/overview", 30000);
  const [acct, setAcct] = useState<string | null>(null);
  const [chain, setChain] = useState<number | null>(null);
  const [bal, setBal] = useState<{ hsk: string; usd: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const want = o?.chainId ?? 133;
  const token = o?.meta?.deployment.token;
  const dec = o?.decimals ?? 6;

  const refresh = useCallback(async (a: string) => {
    const e = eth();
    if (!e) return;
    try {
      const cid = Number(await e.request({ method: "eth_chainId" }));
      setChain(cid);
      if (cid !== want) return setBal(null);
      const hsk = BigInt((await e.request({ method: "eth_getBalance", params: [a, "latest"] })) as string);
      let usd = 0n;
      if (token) {
        // balanceOf(address)
        const data = "0x70a08231" + a.slice(2).toLowerCase().padStart(64, "0");
        usd = BigInt((await e.request({ method: "eth_call", params: [{ to: token, data }, "latest"] })) as string);
      }
      setBal({ hsk: fmt(hsk, 18), usd: fmt(usd, dec, 2) });
    } catch (x) {
      setErr((x as Error).message);
    }
  }, [want, token, dec]);

  useEffect(() => {
    const e = eth();
    if (!e) return;
    void e.request({ method: "eth_accounts" }).then((a) => { const l = a as string[]; if (l[0]) setAcct(l[0]); });
    const onAcc = (a: unknown) => setAcct((a as string[])[0] ?? null);
    const onChain = () => acct && void refresh(acct);
    e.on?.("accountsChanged", onAcc);
    e.on?.("chainChanged", onChain);
    return () => { e.removeListener?.("accountsChanged", onAcc); e.removeListener?.("chainChanged", onChain); };
  }, [acct, refresh]);

  useEffect(() => { if (acct) void refresh(acct); }, [acct, refresh]);

  const connect = async () => {
    setErr(null);
    const e = eth();
    if (!e) return setErr("No browser wallet found. Install MetaMask or another EIP-1193 wallet.");
    try {
      const a = (await e.request({ method: "eth_requestAccounts" })) as string[];
      setAcct(a[0] ?? null);
    } catch (x) {
      setErr((x as Error).message);
    }
  };

  const switchChain = async () => {
    const e = eth();
    if (!e) return;
    setErr(null);
    try {
      await e.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex(want) }] });
    } catch (x) {
      if ((x as { code?: number }).code === 4902) {
        try {
          await e.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: hex(want),
              chainName: want === 177 ? "HashKey Chain" : "HashKey Chain Testnet",
              nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
              rpcUrls: [want === 177 ? "https://mainnet.hsk.xyz" : "https://testnet.hsk.xyz"],
              blockExplorerUrls: o?.explorer ? [o.explorer] : undefined,
            }],
          });
        } catch (y) { setErr((y as Error).message); }
      } else setErr((x as Error).message);
    }
  };

  if (!acct) {
    return (
      <div className="relative">
        <button onClick={connect} className="btn btn-ghost !py-2.5">Connect wallet</button>
        {err && <div className="absolute right-0 top-12 z-40 w-64 rounded-lg bg-[#fbe9ea] p-3 text-xs text-down">{err}</div>}
      </div>
    );
  }
  const wrong = chain !== null && chain !== want;
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="btn btn-ghost !py-2.5">
        <span className={`mr-2 inline-block h-2 w-2 rounded-full ${wrong ? "bg-down" : "bg-up"}`} />
        <span className="mono">{short(acct, 6, 4)}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-40 w-72 rounded-2xl border border-line bg-white p-4 text-sm shadow-lg">
          <div className="mono break-all text-xs text-muted">{acct}</div>
          {wrong ? (
            <div className="mt-3">
              <p className="text-down">Wrong network (chain {chain}). Sealed runs on {want}.</p>
              <button onClick={switchChain} className="btn btn-blue mt-2 !py-2">Switch to chain {want}</button>
            </div>
          ) : (
            <dl className="mt-3 space-y-1">
              <div className="flex justify-between"><dt className="text-muted">HSK</dt><dd className="mono">{bal?.hsk ?? "…"}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">dUSDC</dt><dd className="mono">{bal?.usd ?? "…"}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Network</dt><dd>chain {chain}</dd></div>
            </dl>
          )}
          {o?.explorer && <a className="mt-3 block text-xs text-blue" href={`${o.explorer}/address/${acct}`} target="_blank" rel="noreferrer">View on explorer</a>}
          <p className="mt-3 text-xs text-muted">Read-only. The Vault signs seal and spend; your browser wallet never holds the budget.</p>
          {err && <p className="mt-2 text-xs text-down">{err}</p>}
          <button onClick={() => { setAcct(null); setOpen(false); }} className="mt-3 text-xs text-muted underline">Hide</button>
        </div>
      )}
    </div>
  );
}
