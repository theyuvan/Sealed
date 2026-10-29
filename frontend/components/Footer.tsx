import { Logo } from "./Logo";

export function Footer() {
  return (
    <footer className="border-t border-line bg-white">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-6 px-6 py-12 md:flex-row md:items-center md:justify-between">
        <Logo size={28} />
        <p className="max-w-xl text-sm text-muted">
          Built on HashKey Chain for the HSK Chain Horizon Hackathon, Track 2. The Groth16 setup is a hackathon setup, not a ceremony. Behavioral privacy is reduced, not eliminated. All figures on this site are simulated.
        </p>
      </div>
    </footer>
  );
}
