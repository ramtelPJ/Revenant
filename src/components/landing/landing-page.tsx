"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/lib/motion";
import { browserObserver, setupReveal } from "@/lib/reveal";
import { LogoMark } from "../brand";
import { HeroCanvas } from "../hero/hero-canvas";

const ARROW = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </svg>
);

// An illustration of what a run looks like, labelled as such on the page. It is not output from a real project.
const TERMINAL: [string, string][] = [
  ["> revenant exhume ./legacy-app", "text-fg"],
  ["", ""],
  ["[01] Reading repository...", "text-muted"],
  ["[02] Inspecting project structure...", "text-muted"],
  ["[03] Checking dependencies...", "text-muted"],
  ["", ""],
  ["[WARN] Legacy dependency detected", "text-warn"],
  ["[WARN] Build configuration may be incompatible", "text-warn"],
  ["", ""],
  ["[AI] Investigating failure evidence...", "text-accent"],
  ["[AI] Candidate repair identified", "text-accent"],
  ["", ""],
  ["> Ready for review", "text-fg"],
];

/** Fades sections in as they scroll into view. Does nothing when reduced motion is requested. */
function useReveal(root: React.RefObject<HTMLElement | null>, reduce: boolean) {
  useEffect(() => {
    const container = root.current;
    if (!container || reduce || typeof IntersectionObserver === "undefined") return;
    return setupReveal(Array.from(container.querySelectorAll<HTMLElement>("[data-reveal]")), browserObserver);
  }, [root, reduce]);
}

function Terminal({ reduce }: { reduce: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [started, setStarted] = useState(false);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || reduce || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => entry.isIntersecting && setStarted(true), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, [reduce]);

  useEffect(() => {
    if (!started) return;
    const id = setInterval(() => setShown((n) => (n >= TERMINAL.length ? n : n + 1)), 380);
    return () => clearInterval(id);
  }, [started]);

  const count = reduce ? TERMINAL.length : shown;
  return (
    <div ref={ref} role="log" aria-label="Sample diagnostic terminal" className="min-h-[340px] overflow-x-auto px-[18px] pb-[22px] pt-[18px] font-mono text-[13px] leading-[1.75]">
      {TERMINAL.slice(0, count).map(([text, tone], i) => (
        <div key={i} className={`rv-in whitespace-pre ${tone}`}>
          {text || " "}
        </div>
      ))}
      {count >= TERMINAL.length && <span className="rv-blink text-accent">▋</span>}
    </div>
  );
}

const PAD = "px-[clamp(16px,4vw,48px)]";

export function LandingPage() {
  const root = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  useReveal(root, reduce);

  return (
    <div ref={root}>
      <header className={`sticky top-0 z-20 flex flex-wrap items-center gap-6 border-b-2 border-line bg-bg/80 py-3.5 backdrop-blur-md ${PAD}`}>
        <Link href="/" aria-label="REVENANT home" className="flex items-center gap-2.5 text-fg hover:text-fg">
          <LogoMark />
          <span className="display text-[17px] tracking-[0.14em]">REVENANT</span>
        </Link>
        <nav aria-label="Main" className="ml-auto flex flex-wrap items-center gap-[22px] text-sm">
          <a href="#how" className="text-muted hover:text-fg">How It Works</a>
          <Link href="/cases/new#recent" className="text-muted hover:text-fg">Case Files</Link>
          <Link href="/cases/new" className="btn btn-primary">Launch App</Link>
        </nav>
      </header>

      <main id="main">
        <section
          className={`relative grid min-h-[calc(100vh-66px)] grid-cols-[repeat(auto-fit,minmax(min(100%,460px),1fr))] items-center gap-8 overflow-hidden border-b-2 border-line py-[clamp(40px,7vw,96px)] ${PAD}`}
          style={{ background: "radial-gradient(55% 60% at 72% 42%, rgba(200,80,10,.20), transparent 70%), radial-gradient(18% 16% at 84% 56%, rgba(232,180,74,.08), transparent 70%), var(--color-bg)" }}
        >
          <div
            aria-hidden="true"
            className="rv-drift pointer-events-none absolute inset-[-10%_-20%] z-0 blur-[20px]"
            style={{ background: "radial-gradient(40% 30% at 30% 80%, rgba(180,90,30,.10), transparent 70%), radial-gradient(35% 25% at 75% 90%, rgba(220,120,40,.08), transparent 70%), radial-gradient(25% 20% at 55% 70%, rgba(180,90,30,.06), transparent 70%)" }}
          />
          <div className="relative z-[2] flex max-w-[640px] flex-col gap-7">
            <div className="eyebrow">Dead code. Second life.</div>
            <h1 className="display m-0 text-[clamp(48px,7vw,96px)] leading-[0.95] text-balance">
              Your code isn&apos;t <span className="rv-glitch">dead.</span> Yet.
            </h1>
            <p className="m-0 max-w-[520px] text-[clamp(16px,1.4vw,19px)] leading-[1.6] text-muted text-pretty">
              Forgotten repositories still have stories to tell. Unearth their failures, investigate the evidence, and give them another life with open-source AI.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/cases/new" className="btn btn-primary min-w-[240px] justify-between px-5 py-3.5 text-[15px]">
                Resurrect a Repository {ARROW}
              </Link>
              <a href="#how" className="btn btn-secondary px-5 py-3.5 text-[15px]">See How It Works</a>
            </div>
            <ul className="m-0 grid list-none grid-cols-2 justify-start border-t border-line p-0 font-mono text-xs text-muted sm:grid-cols-[repeat(4,auto)]">
              {["Local AI", "Privacy-first", "Open-source powered", "Verifiable repairs"].map((label, i) => (
                <li key={label} className={`pt-3 ${i === 0 ? "pr-[18px]" : "px-[18px] sm:border-l sm:border-line"}`}>{label}</li>
              ))}
            </ul>
          </div>
          <div className="relative z-[1] h-[clamp(380px,54vw,660px)] min-w-0">
            <HeroCanvas />
          </div>
        </section>

        <section id="trail" className={`grid grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] items-start gap-10 border-b-2 border-line py-[clamp(40px,6vw,80px)] ${PAD}`}>
          <div data-reveal="0" className="flex max-w-[420px] flex-col gap-3.5">
            <div className="eyebrow">Field recording</div>
            <h2 className="display m-0 text-[clamp(28px,3vw,40px)] leading-[1.05]">Every investigation leaves a trail.</h2>
            <p className="m-0 leading-[1.6] text-muted">
              Revenant reads before it runs. Nothing executes until you approve it, and every claim points back to a file or a log line.
            </p>
          </div>
          <div data-reveal="120" className="min-w-0 border border-line bg-raised shadow-[0_30px_80px_rgba(0,0,0,0.45)]">
            <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5 font-mono text-xs text-muted">
              <span className="h-2 w-2 bg-line" />
              <span className="h-2 w-2 bg-line" />
              <span className="h-2 w-2 bg-line" />
              <span className="ml-2">revenant — zsh</span>
              <span className="ml-auto text-warn">Illustrative output</span>
            </div>
            <Terminal reduce={reduce} />
          </div>
        </section>

        <section id="how" className="border-b-2 border-line">
          <div data-reveal="0" className={`flex flex-col gap-3 pb-8 pt-[clamp(40px,6vw,80px)] ${PAD}`}>
            <div className="eyebrow">How it works</div>
            <h2 className="display m-0 text-[clamp(32px,4vw,56px)] leading-none">Three rites. One verdict.</h2>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] border-t-2 border-line">
            <Rite n="01" title="EXHUME" delay={0} body="Import an abandoned repository. Files are read, never executed." border>
              <div className="border border-line bg-raised px-4 py-3.5 font-mono text-xs leading-[1.9] text-muted">
                <div className="text-fg">pixel-forge/</div>
                <div>├─ src/</div>
                <div>│  ├─ build.js <span className="text-bad">●</span></div>
                <div>│  └─ cli.js</div>
                <div>├─ .nvmrc <span className="text-warn">●</span></div>
                <div>└─ package.json <span className="text-bad">●</span></div>
              </div>
            </Rite>
            <Rite n="02" title="AUTOPSY" delay={120} body="Investigate structure, dependencies and errors. Findings are labelled confirmed, supported, or hypothesis." border>
              <div className="border border-line bg-raised font-mono text-xs">
                <div className="flex justify-between gap-2 border-b border-line px-3.5 py-2.5"><span>node-sass@4.9.0</span><span className="text-bad">confirmed</span></div>
                <div className="flex justify-between gap-2 border-b border-line px-3.5 py-2.5"><span>engines: node &lt;10</span><span className="text-warn">supported</span></div>
                <div className="flex justify-between gap-2 px-3.5 py-2.5"><span>css output drift</span><span className="text-muted">hypothesis</span></div>
              </div>
            </Rite>
            <Rite n="03" title="RESURRECT" delay={240} body="Review a narrow repair, approve it, and verify in an isolated sandbox that the project works again.">
              <div className="border border-line bg-raised py-2.5 font-mono text-xs leading-[1.9]">
                <div className="bg-bad/10 px-3.5 text-bad">- const sass = require(&apos;node-sass&apos;);</div>
                <div className="bg-ok/10 px-3.5 text-ok">+ const sass = require(&apos;sass&apos;);</div>
                <div className="mt-1.5 px-3.5 text-muted">$ npm ci  <span className="text-ok">exit 0</span></div>
              </div>
            </Rite>
          </div>
        </section>

        <section id="begin" className={`flex flex-col items-start gap-7 border-b-2 border-line py-[clamp(56px,9vw,128px)] ${PAD}`}>
          <h2 data-reveal="0" className="display m-0 max-w-[900px] text-[clamp(40px,6vw,84px)] leading-[0.98] text-balance">Some code deserves another life.</h2>
          <Link href="/cases/new" className="btn btn-primary min-w-[300px] justify-between px-[22px] py-4 text-base">
            Enter the Resurrection Lab {ARROW}
          </Link>
        </section>
      </main>

      <footer className={`flex flex-wrap justify-between gap-4 py-5 font-mono text-xs text-muted ${PAD}`}>
        <span>REVENANT — built for Ghost in the Machine</span>
        <span>Runs on your machine. Your code stays there.</span>
      </footer>
    </div>
  );
}

function Rite({ n, title, body, delay, border, children }: { n: string; title: string; body: string; delay: number; border?: boolean; children: React.ReactNode }) {
  return (
    <div data-reveal={delay} className={`flex flex-col gap-[18px] px-[clamp(16px,3vw,40px)] pb-10 pt-8 transition-colors duration-300 hover:bg-raised ${border ? "border-r border-line" : ""}`}>
      <div className="flex items-baseline gap-3.5">
        <span className="font-mono text-[13px] text-accent">{n}</span>
        <h3 className="display m-0 text-[26px]">{title}</h3>
      </div>
      <p className="m-0 leading-[1.6] text-muted">{body}</p>
      {children}
    </div>
  );
}
