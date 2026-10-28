import { splitInlineCode } from "@/lib/health-problems";

/** Text where `backticked` parts are shown as code. Everything is rendered as text, never as HTML. */
export function InlineText({ text }: { text: string }) {
  return (
    <>
      {splitInlineCode(text).map((piece, i) =>
        piece.code ? (
          <code key={i} className="rounded bg-raised px-1.5 py-0.5 font-mono text-[0.9em] text-fg">
            {piece.text}
          </code>
        ) : (
          <span key={i}>{piece.text}</span>
        ),
      )}
    </>
  );
}
