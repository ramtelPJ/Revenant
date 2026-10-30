import { Brand } from "@/components/brand";

export const metadata = { title: "Locked · Revenant" };

export default function Locked() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-4 py-16">
      <Brand />
      <h1 className="display m-0 text-4xl leading-none">This door is locked</h1>
      <p className="m-0 text-muted">
        Revenant only opens from the private link it prints when it starts. That link works once, for 15 minutes, and a restart makes a new one.
      </p>
      <ol className="m-0 flex list-decimal flex-col gap-2 pl-5 text-sm leading-normal">
        <li>
          In the terminal, run <code className="font-mono">npm run revenant</code>.
        </li>
        <li>Open the link it prints (it also opens your browser).</li>
        <li>If the link was already used, stop Revenant with Ctrl+C and start it again for a new one.</li>
      </ol>
    </main>
  );
}
