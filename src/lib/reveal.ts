type ObserverFactory = (onVisible: (el: HTMLElement) => void) => { observe(el: Element): void; unobserve(el: Element): void; disconnect(): void };

/**
 * Hides each element, then fades it in when it scrolls into view (`data-reveal="<delay ms>"`).
 * The returned cleanup stops watching AND puts every element back to fully visible, so switching to reduced
 * motion (or leaving the page) can never leave content hidden.
 */
export function setupReveal(elements: HTMLElement[], createObserver: ObserverFactory): () => void {
  const io = createObserver((el) => {
    el.style.opacity = "1";
    el.style.transform = "none";
    io.unobserve(el);
  });
  for (const el of elements) {
    const delay = Number(el.dataset.reveal) || 0;
    el.style.opacity = "0";
    el.style.transform = "translateY(28px)";
    el.style.transition = `opacity .9s cubic-bezier(.2,.7,.2,1) ${delay}ms, transform .9s cubic-bezier(.2,.7,.2,1) ${delay}ms`;
    io.observe(el);
  }
  return () => {
    io.disconnect();
    for (const el of elements) {
      el.style.opacity = "";
      el.style.transform = "";
      el.style.transition = "";
    }
  };
}

export const browserObserver: ObserverFactory = (onVisible) => {
  const io = new IntersectionObserver(
    (entries) => entries.forEach((entry) => entry.isIntersecting && onVisible(entry.target as HTMLElement)),
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
  );
  return io;
};
