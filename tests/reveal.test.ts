import { describe, expect, test, vi } from "vitest";
import { setupReveal } from "@/lib/reveal";

type Fake = { dataset: { reveal?: string }; style: Record<string, string> };
const el = (reveal?: string): Fake => ({ dataset: { reveal }, style: {} });
const asEls = (...e: Fake[]) => e as unknown as HTMLElement[];

function fakeObserver() {
  const watched: Fake[] = [];
  let onVisible: (el: HTMLElement) => void = () => {};
  const api = {
    factory: (cb: (el: HTMLElement) => void) => {
      onVisible = cb;
      return {
        observe: (e: Element) => void watched.push(e as unknown as Fake),
        unobserve: vi.fn((e: Element) => void watched.splice(watched.indexOf(e as unknown as Fake), 1)),
        disconnect: vi.fn(() => (watched.length = 0)),
      };
    },
    show: (e: Fake) => onVisible(e as unknown as HTMLElement),
    watched,
  };
  return api;
}

describe("setupReveal", () => {
  test("hides each element, with its own delay, and watches it", () => {
    const a = el("0"), b = el("240"), c = el();
    const obs = fakeObserver();
    setupReveal(asEls(a, b, c), obs.factory);
    for (const e of [a, b, c]) expect(e.style).toMatchObject({ opacity: "0", transform: "translateY(28px)" });
    expect(a.style.transition).toContain(" 0ms");
    expect(b.style.transition).toContain(" 240ms");
    expect(c.style.transition).toContain(" 0ms"); // no delay given
    expect(obs.watched).toHaveLength(3);
  });

  test("an element that scrolls into view is shown and no longer watched", () => {
    const a = el("0"), b = el("0");
    const obs = fakeObserver();
    setupReveal(asEls(a, b), obs.factory);
    obs.show(a);
    expect(a.style).toMatchObject({ opacity: "1", transform: "none" });
    expect(b.style.opacity).toBe("0");
    expect(obs.watched).toEqual([b]);
  });

  test("cleanup stops watching AND makes every element visible again (the reduced-motion bug)", () => {
    const hidden = el("0"), shown = el("120");
    const obs = fakeObserver();
    const cleanup = setupReveal(asEls(hidden, shown), obs.factory);
    obs.show(shown);

    cleanup();
    for (const e of [hidden, shown]) expect(e.style).toMatchObject({ opacity: "", transform: "", transition: "" }); // nothing left forcing it hidden
    expect(obs.watched).toHaveLength(0);
  });

  test("no elements is fine", () => {
    expect(() => setupReveal([], fakeObserver().factory)()).not.toThrow();
  });
});
