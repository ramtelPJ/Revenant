"use client";
import { useEffect, useRef } from "react";
import { useReducedMotion } from "@/lib/motion";
import { mountParticleHero } from "./particle-hero";

/**
 * The landing hero. The 3D scene (Three.js) is loaded after the page has painted; if WebGL is missing or the
 * scene fails, the 2D particle skull is drawn instead. Both stop when the component goes away.
 */
export function HeroCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let stopped = false;
    let stop: (() => void) | null = null;
    import("./revenant-hero.js")
      .then((scene) => {
        if (!stopped) stop = scene.mountHero(canvas, { reduce });
      })
      .catch(() => {
        // no WebGL (or the module failed): the design's 2D fallback
        if (!stopped) stop = mountParticleHero(canvas, { reduce });
      });
    return () => {
      stopped = true;
      stop?.();
    };
  }, [reduce]);

  return <canvas ref={ref} aria-hidden="true" className="absolute inset-0 block h-full w-full" />;
}
