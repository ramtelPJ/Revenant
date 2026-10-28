// REVENANT hero: spectral lantern-bearer, from the design prototype. Lazy-loaded; throws if WebGL is unavailable so the caller can fall back to 2D.
// Three.js comes from the local `three` package (the prototype loaded it from a CDN, which would break offline use).
import * as THREE from 'three';

const WHITE = 0xEFE6D6, LAV = 0xFF8A2B, ORANGE = 0xFF8A3D, BG = 0x0A0806;

function radialTex(stops, size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, col]) => gr.addColorStop(o, col)); g.fillStyle = gr; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function cloudTex() {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
  for (let i = 0; i < 46; i++) {
    const x = s * (0.2 + Math.random() * 0.6), y = s * (0.3 + Math.random() * 0.4), r = s * (0.08 + Math.random() * 0.2);
    const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,255,255,.16)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  }
  return new THREE.CanvasTexture(c);
}

export function mountHero(canvas, { reduce = false } = {}) {
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) throw new Error('WebGL unavailable');
  const low = (navigator.hardwareConcurrency || 8) <= 4 || matchMedia('(max-width: 700px)').matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !low, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, low ? 1.25 : 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = !low; renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(BG, 0.055);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 60); camera.position.set(0, 0.35, 7.8);

  scene.add(new THREE.HemisphereLight(0x8a5a38, 0x050302, 0.55));
  const rim = new THREE.DirectionalLight(0xffa868, 1.6); rim.position.set(-4, 6, -2);
  rim.castShadow = !low; rim.shadow.mapSize.set(1024, 1024); rim.shadow.camera.left = -4; rim.shadow.camera.right = 4; rim.shadow.camera.top = 4; rim.shadow.camera.bottom = -4; rim.shadow.radius = 6; rim.shadow.bias = -0.0005;
  scene.add(rim);
  const key = new THREE.DirectionalLight(0xeeeaf4, 0.45); key.position.set(3, 3, 6); scene.add(key);

  const glowTex = radialTex([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,.45)'], [1, 'rgba(255,255,255,0)']]);
  const halo = (color, scale, opacity) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending })); s.scale.setScalar(scale); return s; };

  // ── ground + terminal plinth
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.45 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -1.95; ground.receiveShadow = true; scene.add(ground);
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), new THREE.MeshBasicMaterial({ map: glowTex, color: 0xb84a10, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
  pool.rotation.x = -Math.PI / 2; pool.position.y = -1.94; scene.add(pool);
  const slabMat = new THREE.MeshStandardMaterial({ name: 'obsidian', color: 0x131019, roughness: 0.45, metalness: 0.35 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.2, 1.1), slabMat); slab.position.set(0, -1.85, 0.2); slab.receiveShadow = true; scene.add(slab);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.008, 0.008), new THREE.MeshBasicMaterial({ color: LAV })); edge.position.set(0, -1.749, 0.75); scene.add(edge);
  const tc = document.createElement('canvas'); tc.width = 1024; tc.height = 80; const tg = tc.getContext('2d');
  tg.font = '500 34px "JetBrains Mono", monospace'; tg.fillStyle = '#FF8A2B'; tg.textBaseline = 'middle'; tg.fillText('> revenant exhume ./legacy-app', 30, 42);
  const textTex = new THREE.CanvasTexture(tc); textTex.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.1875), new THREE.MeshBasicMaterial({ map: textTex, transparent: true, opacity: 0.85 })); label.position.set(0, -1.85, 0.752); scene.add(label);
  const cursor = new THREE.Mesh(new THREE.PlaneGeometry(0.035, 0.07), new THREE.MeshBasicMaterial({ color: LAV })); cursor.position.set(0.52, -1.85, 0.753); scene.add(cursor);

  // ── ghost
  const ghost = new THREE.Group(); ghost.name = 'revenant'; scene.add(ghost);
  const sheet = new THREE.MeshStandardMaterial({ name: 'ectoplasm', color: WHITE, emissive: 0x4a2c18, emissiveIntensity: 0.5, roughness: 0.55, transparent: true, opacity: 0.94, side: THREE.DoubleSide });
  const prof = []; const PN = 44;
  for (let i = 0; i <= PN; i++) {
    const t = i / PN; const y = 1.25 - t * 2.35;
    const r = t < 0.3 ? 0.58 * Math.sin(Math.max(0.02, t / 0.3) * Math.PI / 2) : 0.58 + ((t - 0.3) / 0.7) * 0.34 - 0.06 * Math.sin((t - 0.3) / 0.7 * Math.PI);
    prof.push(new THREE.Vector2(r, y));
  }
  const bodyGeo = new THREE.LatheGeometry(prof, 80);
  const base = bodyGeo.attributes.position.array.slice();
  const body = new THREE.Mesh(bodyGeo, sheet); body.castShadow = true; ghost.add(body);

  const socketMat = new THREE.MeshStandardMaterial({ name: 'void', color: 0x0d0a14, roughness: 1 });
  const eyeMat = new THREE.MeshStandardMaterial({ name: 'eyeglow', color: 0x000000, emissive: 0xFF7A1A, emissiveIntensity: 2.6 });
  const eyes = [];
  [-1, 1].forEach(s => {
    const socket = new THREE.Mesh(new THREE.SphereGeometry(0.13, 32, 16), socketMat);
    socket.scale.set(1, 0.6, 0.35); socket.position.set(0.19 * s, 0.8, 0.44); socket.rotation.z = 0.38 * s; socket.rotation.y = 0.35 * s; ghost.add(socket);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 24, 12), eyeMat);
    eye.scale.set(1, 0.5, 0.4); eye.position.set(0.19 * s, 0.795, 0.475); eye.rotation.z = 0.38 * s; ghost.add(eye);
    const h = halo(0xff6a10, 0.6, 0.7); h.position.set(0.19 * s, 0.8, 0.56); ghost.add(h); eyes.push(h);
  });

  // hat — dark, crooked, matte
  const hatMat = new THREE.MeshStandardMaterial({ name: 'hat', color: 0x16121e, roughness: 0.85 });
  const bandMat = new THREE.MeshStandardMaterial({ name: 'band', color: 0x7a2e0a, roughness: 0.7 });
  const hat = new THREE.Group(); hat.position.set(0.04, 1.08, 0); hat.rotation.set(0.1, 0, -0.16); ghost.add(hat);
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.84, 0.035, 64), hatMat); brim.castShadow = true; hat.add(brim);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.44, 0.09, 48), bandMat); band.position.y = 0.06; hat.add(band);
  let seg = hat, y0 = 0.02; const segs = [[0.42, 0.3, 0.34], [0.3, 0.2, 0.3], [0.2, 0.11, 0.26], [0.11, 0.008, 0.24]];
  segs.forEach(([rb, rt, ht], i) => {
    const g = new THREE.Group(); g.position.y = y0; g.rotation.z = i === 0 ? 0 : 0.24 + i * 0.05; seg.add(g);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, ht, 40), hatMat); m.position.y = ht / 2; m.castShadow = true; g.add(m);
    seg = g; y0 = ht - 0.005;
  });

  // sleeves + hands
  const sleeve = (len) => { const g = new THREE.CylinderGeometry(0.15, 0.25, len, 32, 8, true); g.translate(0, -len / 2, 0);
    const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y < -len + 0.02) { const a = Math.atan2(p.getZ(i), p.getX(i)); p.setY(i, y - 0.06 - 0.07 * Math.abs(Math.sin(a * 4))); } } g.computeVertexNormals(); return g; };
  const handMat = sheet;
  const mkArm = (len) => { const pivot = new THREE.Group(); const s = new THREE.Mesh(sleeve(len), sheet); s.castShadow = true; pivot.add(s);
    const hand = new THREE.Group(); hand.position.y = -len - 0.02; pivot.add(hand);
    const palm = new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 12), handMat); palm.scale.set(1, 1.2, 0.7); hand.add(palm);
    [-1, 0, 1].forEach(k => { const f = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.17, 8), handMat); f.position.set(k * 0.045, -0.12, 0.01); f.rotation.z = k * 0.2; f.rotation.x = Math.PI; hand.add(f); });
    return { pivot, hand }; };
  const armR = mkArm(0.95); armR.pivot.position.set(0.48, 0.32, 0); ghost.add(armR.pivot);
  const armL = mkArm(0.8); armL.pivot.position.set(-0.48, 0.3, 0.05); armL.pivot.rotation.x = -0.6; ghost.add(armL.pivot);

  // lantern
  const metal = new THREE.MeshStandardMaterial({ name: 'iron', color: 0x2c2522, roughness: 0.45, metalness: 0.75 });
  const glass = new THREE.MeshStandardMaterial({ name: 'glass', color: 0x2a1408, emissive: ORANGE, emissiveIntensity: 2.4, transparent: true, opacity: 0.8 });
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xffd08a });
  const swing = new THREE.Group(); armR.hand.add(swing);
  const lantern = new THREE.Group(); lantern.position.y = -0.2; swing.add(lantern);
  const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.14, 6), metal); chain.position.y = 0.11; swing.add(chain);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 8, 24), metal); ring.position.y = 0.1; lantern.add(ring);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.09, 4), metal); cap.rotation.y = Math.PI / 4; cap.position.y = 0.05; lantern.add(cap);
  const pane = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.19, 0.13), glass); pane.position.y = -0.1; lantern.add(pane);
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.21, 6), metal); p.position.set(a * 0.068, -0.1, b * 0.068); p.castShadow = true; lantern.add(p); });
  const baseL = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.03, 0.17), metal); baseL.position.y = -0.205; lantern.add(baseL);
  const flame = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 8), flameMat); flame.scale.set(1, 1.8, 1); flame.position.y = -0.11; lantern.add(flame);
  const lampLight = new THREE.PointLight(ORANGE, 4.5, 8, 1.4); lampLight.position.y = -0.1; lantern.add(lampLight);
  const lampHalo = halo(0xff8a3d, 2.2, 0.6); lampHalo.position.y = -0.1; lantern.add(lampHalo);

  // ── purple wisp flame
  const wispOrigin = new THREE.Vector3(-1.35, -1.55, 0.45);
  const wispLight = new THREE.PointLight(0xff5a14, 2.4, 3.5, 1.5); wispLight.position.copy(wispOrigin).add(new THREE.Vector3(0, 0.2, 0)); scene.add(wispLight);
  const wispHalo = halo(0xff5a14, 1.4, 0.6); wispHalo.position.copy(wispLight.position); scene.add(wispHalo);
  const WN = low ? 60 : 130; const wPos = new Float32Array(WN * 3), wCol = new Float32Array(WN * 3), wLife = new Float32Array(WN), wSeed = new Float32Array(WN);
  for (let i = 0; i < WN; i++) { wLife[i] = Math.random(); wSeed[i] = Math.random() * 6.28; }
  const wGeo = new THREE.BufferGeometry(); wGeo.setAttribute('position', new THREE.BufferAttribute(wPos, 3)); wGeo.setAttribute('color', new THREE.BufferAttribute(wCol, 3));
  scene.add(new THREE.Points(wGeo, new THREE.PointsMaterial({ size: 0.14, map: glowTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));

  // ── pumpkins (dim, in the fog)
  const pumpkinGeo = (() => { const g = new THREE.SphereGeometry(0.5, 48, 28); const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i); const a = Math.atan2(z, x); const k = 0.9 + 0.1 * Math.pow(Math.abs(Math.sin(a * 4)), 0.5); p.setXYZ(i, x * k, y * 0.78, z * k); }
    g.computeVertexNormals(); return g; })();
  const rind = new THREE.MeshStandardMaterial({ name: 'rind', color: 0x9a4418, emissive: 0x2a0c03, roughness: 0.65 });
  const stemMat = new THREE.MeshStandardMaterial({ name: 'stem', color: 0x2b2216, roughness: 0.9 });
  const carve = new THREE.MeshBasicMaterial({ color: 0xffa24d, side: THREE.DoubleSide });
  const tri = (w, h) => { const s = new THREE.Shape(); s.moveTo(-w / 2, -h / 2); s.lineTo(w / 2, -h / 2); s.lineTo(0, h / 2); s.closePath(); return new THREE.ShapeGeometry(s); };
  const mouth = (() => { const s = new THREE.Shape(); s.moveTo(-0.2, 0.02); [[-0.12, -0.04], [-0.07, 0.0], [0, -0.06], [0.07, 0.0], [0.12, -0.04], [0.2, 0.02], [0.1, -0.1], [-0.1, -0.1]].forEach(([x, y]) => s.lineTo(x, y)); s.closePath(); return new THREE.ShapeGeometry(s); })();
  const pumpkins = [[2.0, -1.1, -0.6, 0.36, 0], [-2.2, 0.6, -1.4, 0.3, 2.1], [1.7, 1.25, -2.2, 0.26, 4.2]].map(([x, y, z, s, ph]) => {
    const g = new THREE.Group(); g.position.set(x, y, z); g.scale.setScalar(s);
    const m = new THREE.Mesh(pumpkinGeo, rind); m.castShadow = true; g.add(m);
    const st = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.06, 0.2, 8), stemMat); st.position.y = 0.45; st.rotation.z = 0.25; g.add(st);
    const face = new THREE.Group(); face.position.z = 0.455; g.add(face);
    [-1, 1].forEach(k => { const e = new THREE.Mesh(tri(0.12, 0.11), carve); e.position.set(k * 0.13, 0.08, 0); face.add(e); });
    const mo = new THREE.Mesh(mouth, carve); mo.position.y = -0.07; face.add(mo);
    scene.add(g); return { g, x, y, z, ph };
  });

  // ── dead trees, far back
  const bark = new THREE.MeshStandardMaterial({ name: 'bark', color: 0x0c0a10, roughness: 1 });
  const branch = (parent, len, rad, depth, rng) => {
    const g = new THREE.Group(); parent.add(g);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.6, rad, len, 5), bark); m.position.y = len / 2; g.add(m);
    if (depth > 0) for (let i = 0; i < 2 + (rng() > 0.6 ? 1 : 0); i++) {
      const c = branch(g, len * (0.6 + rng() * 0.2), rad * 0.62, depth - 1, rng); c.position.y = len * (0.65 + rng() * 0.35); c.rotation.z = (rng() - 0.5) * 1.6; c.rotation.y = rng() * 6.28;
    }
    return g;
  };
  let seed = 7; const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  [[-4.6, 0.25], [4.8, -0.3]].forEach(([x, lean]) => { const t = branch(scene, 1.6, 0.12, low ? 3 : 4, rng); t.position.set(x, -1.95, -3.5); t.rotation.z = lean; });

  // ── mist
  const cTex = cloudTex(); const mists = [];
  for (let i = 0; i < (low ? 5 : 9); i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: cTex, color: i % 3 ? 0x6e5440 : 0x8a6a50, transparent: true, opacity: 0.1 + Math.random() * 0.12, depthWrite: false }));
    const s = 5 + Math.random() * 5; m.scale.set(s, s * 0.55, 1);
    m.position.set((Math.random() - 0.5) * 8, -1.6 + Math.random() * 2.2, -3 + Math.random() * 3.6); m.rotation.z = Math.random() * 6.28;
    scene.add(m); mists.push({ m, v: 0.05 + Math.random() * 0.08, r: (Math.random() - 0.5) * 0.03 });
  }

  // ── motes
  const DN = low ? 220 : 520; const dPos = new Float32Array(DN * 3), dCol = new Float32Array(DN * 3), dV = new Float32Array(DN);
  const cA = new THREE.Color(LAV), cB = new THREE.Color(WHITE), cC = new THREE.Color(0xffd08a);
  for (let i = 0; i < DN; i++) { dPos[i * 3] = (Math.random() - 0.5) * 12; dPos[i * 3 + 1] = -2 + Math.random() * 5.5; dPos[i * 3 + 2] = -4 + Math.random() * 7; dV[i] = 0.04 + Math.random() * 0.12;
    const c = Math.random() < 0.1 ? cC : Math.random() < 0.5 ? cA : cB; const k = 0.35 + Math.random() * 0.65; dCol[i * 3] = c.r * k; dCol[i * 3 + 1] = c.g * k; dCol[i * 3 + 2] = c.b * k; }
  const dGeo = new THREE.BufferGeometry(); dGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3)); dGeo.setAttribute('color', new THREE.BufferAttribute(dCol, 3));
  scene.add(new THREE.Points(dGeo, new THREE.PointsMaterial({ size: 0.05, map: glowTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));

  // ── loop
  let mx = 0, my = 0, tx = 0, ty = 0, sp = 0, visible = true, raf = 0, last = performance.now(), t = 0;
  const onMove = (e) => { tx = e.clientX / window.innerWidth - 0.5; ty = e.clientY / window.innerHeight - 0.5; };
  const onScroll = () => { const hgt = canvas.parentElement?.offsetHeight || 700; sp = Math.min(1, Math.max(0, window.scrollY / (hgt * 1.4))); };
  window.addEventListener('mousemove', onMove, { passive: true }); window.addEventListener('scroll', onScroll, { passive: true });
  const resize = () => { const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.fov = w / h < 0.85 ? 38 : 32; camera.updateProjectionMatrix(); if (reduce) render(0); };
  const ro = new ResizeObserver(resize); ro.observe(canvas);
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }); io.observe(canvas);

  const v = new THREE.Vector3();
  function update(dt) {
    t += dt; mx += (tx - mx) * 0.04; my += (ty - my) * 0.04;
    ghost.position.y = 0.12 + Math.sin(t * 0.9) * 0.12; ghost.rotation.y = Math.sin(t * 0.33) * 0.22 + mx * 0.55; ghost.rotation.z = Math.sin(t * 0.6) * 0.035;
    hat.rotation.z = -0.16 + Math.sin(t * 0.7 + 1) * 0.03;
    armR.pivot.rotation.z = 1.12 + Math.sin(t * 0.8) * 0.05; armL.pivot.rotation.z = -0.75 + Math.sin(t * 1.1 + 1) * 0.07;
    swing.rotation.z = -(armR.pivot.rotation.z + ghost.rotation.z) + Math.sin(t * 1.3) * 0.12; swing.rotation.x = Math.sin(t * 0.9) * 0.08;
    lampLight.intensity = 4.3 + Math.sin(t * 13) * 0.25 + Math.sin(t * 7.3) * 0.3; lampHalo.material.opacity = 0.42 + Math.sin(t * 11) * 0.05; flame.scale.y = 1.8 + Math.sin(t * 17) * 0.25;
    eyes.forEach(e => (e.material.opacity = 0.5 + Math.sin(t * 2.1) * 0.12));
    const p = bodyGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const bx = base[i * 3], by = base[i * 3 + 1], bz = base[i * 3 + 2]; const b = Math.min(1, Math.max(0, -by / 1.1)); if (b === 0) continue;
      const a = Math.atan2(bz, bx), b2 = b * b;
      const rk = 1 + 0.07 * b * Math.sin(a * 5 + t * 1.6);
      const tatter = b2 * (0.16 + 0.14 * Math.sin(a * 9 + 1.3) + 0.08 * Math.sin(a * 23) + 0.05 * Math.sin(a * 7 - t * 2));
      p.setXYZ(i, bx * rk - b2 * 0.42 + b2 * 0.1 * Math.sin(t * 1.2 + by * 2), by - tatter, bz * rk + b2 * 0.05 * Math.sin(t * 1.5 + a));
    }
    p.needsUpdate = true; bodyGeo.computeVertexNormals();
    for (let i = 0; i < WN; i++) {
      wLife[i] += dt * (0.55 + (wSeed[i] % 1) * 0.4); if (wLife[i] > 1) wLife[i] -= 1; const l = wLife[i];
      wPos[i * 3] = wispOrigin.x + Math.sin(wSeed[i] + t * 3) * 0.22 * (1 - l * 0.7); wPos[i * 3 + 1] = wispOrigin.y + l * 0.75; wPos[i * 3 + 2] = wispOrigin.z + Math.cos(wSeed[i] * 2) * 0.18 * (1 - l * 0.7);
      const k = Math.sin(l * Math.PI) * 0.9; wCol[i * 3] = 1.0 * k; wCol[i * 3 + 1] = 0.42 * k * (1 - l * 0.6); wCol[i * 3 + 2] = 0.08 * k;
    }
    wGeo.attributes.position.needsUpdate = true; wGeo.attributes.color.needsUpdate = true;
    wispLight.intensity = 2 + Math.sin(t * 9) * 0.35 + Math.sin(t * 5.1) * 0.25;
    for (let i = 0; i < DN; i++) { dPos[i * 3 + 1] += dV[i] * dt; dPos[i * 3] += Math.sin(t * 0.4 + i) * 0.0015; if (dPos[i * 3 + 1] > 3.5) dPos[i * 3 + 1] = -2; }
    dGeo.attributes.position.needsUpdate = true;
    pumpkins.forEach(({ g, x, y, z, ph }) => { g.position.set(x + Math.sin(t * 0.25 + ph) * 0.25, y + Math.sin(t * 0.7 + ph) * 0.15, z); g.rotation.y = Math.sin(t * 0.3 + ph) * 0.9 - 0.2; g.rotation.z = Math.sin(t * 0.5 + ph) * 0.08; });
    mists.forEach(o => { o.m.position.x += o.v * dt; o.m.rotation.z += o.r * dt; if (o.m.position.x > 6) o.m.position.x = -6; });
    cursor.visible = Math.floor(t * 2) % 2 === 0;
    camera.position.set(mx * 0.9, 0.35 - my * 0.45 + sp * 0.4, 7.8 + sp * 2.5); v.set(0, 0.15 - sp * 0.4, 0); camera.lookAt(v);
    canvas.style.opacity = String(1 - sp * 0.8);
  }
  function render(dt) { update(dt); renderer.render(scene, camera); }
  function frame(now) { raf = requestAnimationFrame(frame); const dt = Math.min(0.05, (now - last) / 1000); last = now; if (!visible || document.hidden) return; render(dt); }

  canvas.style.transition = 'opacity 1.2s ease'; canvas.style.opacity = '0';
  resize();
  if (reduce) { t = 2; render(0); canvas.style.opacity = '1'; }
  else { render(0.016); requestAnimationFrame(() => { canvas.style.opacity = '1'; setTimeout(() => (canvas.style.transition = 'none'), 1300); }); raf = requestAnimationFrame(frame); }

  return () => {
    cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
    window.removeEventListener('mousemove', onMove); window.removeEventListener('scroll', onScroll);
    scene.traverse(o => { o.geometry?.dispose?.(); const m = o.material; (Array.isArray(m) ? m : m ? [m] : []).forEach(x => { x.map?.dispose?.(); x.dispose(); }); });
    renderer.dispose();
  };
}
