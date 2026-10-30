"use client";
import Link from "next/link";
import { TopBar } from "@/components/brand";

/** Shown when a page crashes while drawing. The cause is never shown: it may hold paths or file contents. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <TopBar trail="error" />
      <main id="main" className="mx-auto max-w-xl px-4 py-16">
        <h1 className="display m-0 text-4xl leading-none">Something went wrong</h1>
        <p role="alert" className="mt-4 text-muted">Something went wrong. Please try again. Your project and its results on this machine are not affected.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={reset} className="btn btn-primary px-[18px] py-[11px]">Try again</button>
          <Link href="/cases/new" className="btn btn-secondary px-[18px] py-[11px]">Back to Case Files</Link>
        </div>
      </main>
    </>
  );
}
