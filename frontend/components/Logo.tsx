// Mark: a padlock whose body carries an "S". Same artwork as public/logo-mark.svg.
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Sealed">
      <defs>
        <linearGradient id="sealed-g" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2f6bff" />
          <stop offset="1" stopColor="#0035b8" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill="url(#sealed-g)" />
      <path d="M22 27v-5a10 10 0 0 1 20 0v5" fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth="4" strokeLinecap="round" />
      <rect x="17" y="27" width="30" height="24" rx="7" fill="#fff" />
      <path d="M39 33.5c-1.6-1.6-4-2-6.5-2-3 0-5 1.4-5 3.4 0 2.3 2.2 3 5.2 3.7 3.2.8 5.8 1.5 5.8 4.2 0 2.2-2.2 3.6-5.8 3.6-2.7 0-5.2-.8-6.9-2.4" fill="none" stroke="#0049e6" strokeWidth="3.4" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={size} />
      <span className="headline text-[28px] leading-none text-ink">Sealed</span>
    </span>
  );
}
