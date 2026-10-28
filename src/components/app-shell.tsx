"use client";
import { usePathname } from "next/navigation";
import { showsBanners } from "@/lib/health-problems";
import { HealthBanner, SessionBanner } from "./health-banner";

/**
 * Wraps every page: a skip link, and a strip for the two global notices (session ended, setup problems) that only
 * takes up room when there is something to say. Each page draws its own header and its own <main id="main">.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const banners = showsBanners(usePathname());
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:bg-raised focus:px-3 focus:py-2">
        Skip to content
      </a>
      {banners && (
        <div aria-label="Notices" className="space-y-3 border-b-2 border-line bg-bg px-[clamp(16px,4vw,48px)] py-3 empty:hidden">
          <SessionBanner />
          <HealthBanner />
        </div>
      )}
      {children}
    </>
  );
}
