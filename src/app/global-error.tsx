"use client";
import "./globals.css"; // this page replaces the layout, which is where the stylesheet is normally loaded

// The last resort: even the layout failed, so this page brings its own <html> and body.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="mx-auto max-w-xl px-4 py-16">
          <h1 className="m-0 text-3xl font-semibold">Something went wrong</h1>
          <p role="alert" className="mt-4 text-muted">Something went wrong. Please try again.</p>
          <button type="button" onClick={reset} className="btn btn-primary mt-6 px-[18px] py-[11px]">Try again</button>
        </main>
      </body>
    </html>
  );
}
