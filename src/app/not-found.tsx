import Link from "next/link";
import { TopBar } from "@/components/brand";

export const metadata = { title: "Not found · Revenant" };

export default function NotFound() {
  return (
    <>
      <TopBar trail="not found" />
      <main id="main" className="mx-auto max-w-xl px-4 py-16">
        <h1 className="display m-0 text-4xl leading-none">That page isn&apos;t here</h1>
        <p className="mt-4 text-muted">The link may be wrong, or the case may have been deleted.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/cases/new" className="btn btn-primary px-[18px] py-[11px]">Open Case Files</Link>
          <Link href="/" className="btn btn-secondary px-[18px] py-[11px]">Home</Link>
        </div>
      </main>
    </>
  );
}
