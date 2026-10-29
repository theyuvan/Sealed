import Link from "next/link";
import { Section } from "@/components/Ui";
import { PhoneCard } from "@/components/PhoneCard";
import { PriceBoard } from "@/components/PriceBoard";
import { AppPreview } from "@/components/AppPreview";

const tickers: [string, string][] = [
  ["TSLA", "left-[8%] top-[6%] text-sm"], ["NVDA", "left-[14%] top-[22%] text-base"], ["AAPL", "right-[8%] top-[4%] text-3xl"],
  ["META", "right-[4%] top-[34%] text-2xl"], ["MSFT", "right-[14%] top-[56%] text-2xl"], ["AMZN", "right-[2%] top-[78%] text-2xl"],
  ["SPY", "left-[44%] top-[0%] text-lg"], ["QQQ", "left-[30%] bottom-[2%] text-lg"],
];

const learn = [
  { t: "How Sealed hides your budget", d: "The user's rules are committed as a salted Poseidon hash. The agent only ever sees offers, never the mandate…", bg: "bg-night", e: "🔒" },
  { t: "Can a zero-knowledge proof replace trust?", d: "A Groth16 proof shows a deal fits the sealed rules, burns the old note and binds the cart and seller…", bg: "bg-blue", e: "🧾" },
  { t: "What if a seller takes the money?", d: "Escrow only pays the latest voucher, signed after each delivery passes deterministic checks. The rest is refunded…", bg: "bg-[#b9c7c1]", e: "↩" },
];

export default function Home() {
  return (
    <>
      <Section className="!pb-0">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <PhoneCard />
          <div>
            <h1 className="display text-[56px] md:text-[80px]">Agents that pay without leaking the budget.</h1>
            <p className="mt-6 text-lg text-muted">Negotiate and settle on a platform where the spending rules stay sealed, and money only moves on delivery.</p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link href="/dashboard" className="btn btn-blue">Seal a mandate</Link>
              <Link href="/negotiate" className="btn btn-ghost">Watch a negotiation</Link>
            </div>
            <p className="mt-10 text-xs text-muted">Simulated data. Running on HSK testnet 133 with a local HSP stand-in.</p>
          </div>
        </div>
      </Section>

      <Section>
        <div className="relative overflow-hidden rounded-[32px] bg-night text-white">
          <div className="grid items-center gap-8 p-8 md:grid-cols-2 md:p-16">
            <div className="relative h-[300px]" aria-hidden>
              {tickers.map(([t, c]) => (
                <span key={t} className={`absolute font-normal text-blue/80 ${c}`}>{t}</span>
              ))}
            </div>
            <div>
              <h2 className="display text-4xl md:text-5xl">Six attacks, six blocked.</h2>
              <p className="mt-5 max-w-lg text-white/70">A scripted rogue seller tries prompt injection, fake fees, probing, trajectory inference, cart swaps and proof replay. None of them move any money.</p>
              <Link href="/attacks" className="btn btn-light mt-8">Learn more</Link>
            </div>
          </div>
        </div>
        <p className="mx-auto mt-6 max-w-2xl text-center text-xs text-muted">Attack results mirror the e2e test suite. Figures shown here are simulated.</p>
      </Section>

      <Section tint>
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <h2 className="display text-4xl md:text-5xl">Meet the sellers: honest, and not so honest.</h2>
            <p className="mt-5 text-muted">Simply and securely negotiate with seller agents over x402 endpoints, paid through HSP.</p>
            <Link href="/negotiate" className="btn btn-dark mt-8">Start a negotiation</Link>
          </div>
          <PriceBoard />
        </div>
      </Section>

      <Section>
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <AppPreview />
          <div>
            <h2 className="display text-4xl md:text-5xl">Pay on delivery, designed for agents.</h2>
            <p className="mt-5 max-w-lg text-muted">One proof opens a session. Each call is paid with a signed cumulative voucher, only after the delivery passes its checks. At close the seller gets what was delivered and the rest is refunded.</p>
            <Link href="/receipts/0x5e41c2" className="btn btn-dark mt-8">See a receipt</Link>
          </div>
        </div>
      </Section>

      <Section tint>
        <div className="grid gap-8 lg:grid-cols-2">
          <h2 className="display text-4xl md:text-5xl">New to Sealed? Learn the basics.</h2>
          <div>
            <p className="text-muted">How sealed mandates, spend proofs and escrow sessions fit together, in plain language.</p>
            <Link href="/dashboard" className="btn btn-dark mt-6">Get started</Link>
          </div>
        </div>
        <div className="mt-12 grid gap-8 md:grid-cols-3">
          {learn.map((l) => (
            <article key={l.t}>
              <div className={`flex h-48 items-center justify-center rounded-[24px] text-6xl ${l.bg}`} aria-hidden>{l.e}</div>
              <h3 className="mt-5 text-2xl leading-tight">{l.t}</h3>
              <p className="mt-3 text-sm text-muted">{l.d}</p>
            </article>
          ))}
        </div>
      </Section>
    </>
  );
}
