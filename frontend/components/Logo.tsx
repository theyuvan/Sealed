export function Logo({ size = 32 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="inline-flex items-center justify-center rounded-full bg-blue text-white"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
      </span>
      <span className="text-xl font-semibold tracking-tight text-blue">Sealed</span>
    </span>
  );
}
