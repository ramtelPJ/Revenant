// The 2D fallback hero from the design: a skull built from code characters, with error fragments orbiting it.
// Used when WebGL is not available or the 3D scene fails to load.
export function mountParticleHero(cv: HTMLCanvasElement, { reduce = false }: { reduce?: boolean } = {}): () => void {
  const ctx = cv.getContext("2d");
  if (!ctx) return () => {};
  const chars = "{}[]();=<>/\\01$#*+:.".split("");
  const pts: { x: number; y: number; z: number; c: string; ph: number }[] = [];
  const N = 900;
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(1 - y * y);
    const th = i * 2.399963;
    let x = Math.cos(th) * r;
    const z = Math.sin(th) * r;
    if (z > 0.25 && (Math.hypot(x - 0.36, y + 0.02) < 0.21 || Math.hypot(x + 0.36, y + 0.02) < 0.21)) continue; // eye sockets
    if (z > 0.5 && Math.abs(x) < 0.08 && y > 0.18 && y < 0.36) continue; // nose
    if (y > 0.38) x *= 1 - (y - 0.38) * 0.7; // taper the crown
    pts.push({ x, y: y * 1.12, z, c: chars[i % chars.length], ph: Math.random() * 6.28 });
  }
  const frags = ["require('node-sass')", "gyp ERR!", "exit 1", "ABI 115", "npm ci", "renderSync()", "v8.11.3", '"engines"'];
  let mx = 0, my = 0, tx = 0, ty = 0, raf = 0;
  const onMove = (e: MouseEvent) => {
    const b = cv.getBoundingClientRect();
    tx = (e.clientX - b.left) / b.width - 0.5;
    ty = (e.clientY - b.top) / b.height - 0.5;
  };
  window.addEventListener("mousemove", onMove);
  const t0 = performance.now();

  const draw = (now: number) => {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    mx += (tx - mx) * 0.05;
    my += (ty - my) * 0.05;
    const t = reduce ? 2 : (now - t0) / 1000;
    const ay = Math.sin(t * 0.35) * 0.55 + mx * 0.9, ax = -0.12 + my * 0.6;
    const R = Math.min(w, h) * 0.3, cx = w / 2, cy = h * 0.44;
    const cyA = Math.cos(ay), syA = Math.sin(ay), cxA = Math.cos(ax), sxA = Math.sin(ax);

    // terminal plinth
    const py0 = cy + R * 1.45;
    ctx.strokeStyle = "rgba(255,138,43,.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - R * 1.1, py0 + 28);
    ctx.lineTo(cx - R * 0.8, py0);
    ctx.lineTo(cx + R * 0.8, py0);
    ctx.lineTo(cx + R * 1.1, py0 + 28);
    ctx.closePath();
    ctx.stroke();
    const g = ctx.createRadialGradient(cx, py0, 0, cx, py0, R * 1.2);
    g.addColorStop(0, "rgba(255,138,43,.12)");
    g.addColorStop(1, "rgba(255,138,43,0)");
    ctx.fillStyle = g;
    ctx.fillRect(cx - R * 1.3, py0 - R, R * 2.6, R + 40);
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,138,43,.7)";
    ctx.fillText("> revenant exhume" + (Math.floor(t * 2) % 2 ? "_" : " "), cx, py0 + 15);

    // the entity
    for (const p of pts) {
      const br = 1 + 0.025 * Math.sin(t * 1.4 + p.y * 3);
      const x = p.x * br, y = p.y * br, z = p.z * br;
      const x1 = x * cyA + z * syA, z1 = -x * syA + z * cyA;
      const y2 = y * cxA - z1 * sxA, z2 = y * sxA + z1 * cxA;
      const f = 2.6 / (2.6 - z2);
      const drift = reduce ? 0 : Math.sin(t * 0.9 + p.ph) * 0.012;
      const sx = cx + (x1 + drift) * R * f, sy = cy + y2 * R * f;
      const a = 0.08 + 0.72 * ((z2 + 1) / 2) ** 1.6;
      const flick = !reduce && Math.sin(t * 7 + p.ph * 9) > 0.995;
      ctx.fillStyle = flick ? "rgba(241,109,114,.8)" : `rgba(255,138,43,${a.toFixed(3)})`;
      ctx.fillText(p.c, sx, sy);
    }

    // orbiting fragments
    ctx.font = '11px "JetBrains Mono", monospace';
    frags.forEach((s, k) => {
      const ang = t * 0.22 + (k * Math.PI * 2) / frags.length;
      const ox = Math.cos(ang) * R * 1.75, oz = Math.sin(ang);
      const oy = Math.sin(ang) * R * 0.32 - R * 0.1 + (k % 2 ? 1 : -1) * R * 0.18;
      const a = 0.12 + 0.5 * ((oz + 1) / 2);
      ctx.fillStyle = `rgba(239,230,214,${a.toFixed(3)})`;
      ctx.fillText(s, cx + ox + mx * 30 * oz, cy + oy + my * 20);
    });
    if (!reduce) raf = requestAnimationFrame(draw);
  };

  raf = requestAnimationFrame(draw);
  const still = reduce ? setTimeout(() => draw(performance.now()), 300) : undefined;
  return () => {
    cancelAnimationFrame(raf);
    if (still) clearTimeout(still);
    window.removeEventListener("mousemove", onMove);
  };
}
