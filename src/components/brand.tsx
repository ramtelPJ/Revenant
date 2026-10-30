import Link from "next/link";

/** The square mark with two eyes, from the design. */
export function LogoMark() {
  return (
    <span aria-hidden="true" className="relative block h-[18px] w-[18px] border-2 border-accent">
      <span className="absolute left-[2px] top-[3px] h-1 w-1 bg-accent" />
      <span className="absolute right-[2px] top-[3px] h-1 w-1 bg-accent" />
    </span>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" aria-label="REVENANT home" className="flex items-center gap-2.5 text-fg hover:text-fg">
      <LogoMark />
      <span className={`display ${compact ? "text-sm tracking-[0.01em]" : "text-[1.1333rem] tracking-[0.14em]"}`}>REVENANT</span>
    </Link>
  );
}

/** The header of the working pages: brand, where you are, and that page's actions on the right. */
export function TopBar({ trail, children }: { trail?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-4 border-b-2 border-line px-[clamp(16px,4vw,48px)] py-3.5">
      <Brand />
      {trail && <span className="block min-w-0 max-w-full truncate font-mono text-xs text-muted">/ {trail}</span>}
      {children && <div className="ml-auto flex flex-wrap items-center gap-3">{children}</div>}
    </header>
  );
}
