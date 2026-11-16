import { memo, useEffect, useRef } from 'react';

/**
 * Atmospheric layers: gradient, perspective grid (echoing the poster's blue grid),
 * drifting brand-colour glows and particles.
 *
 * Performance design (measured at 1920×1080, see README "Performance"):
 *  - The floor/ceiling perspective grids are drawn on ONE flat canvas together with the particles,
 *    using the exact projection of the original CSS `perspective(700px) rotateX(±62deg)` layers.
 *    Two 3840-px-wide, masked 3D layers were the largest remaining compositing cost.
 *  - The canvas animates at 30 fps for the slow ambient drift (60 fps only during a burst),
 *    stops completely when the tab is hidden, and draws once and stops in Performance mode /
 *    reduced motion.
 *  - `intensity` is NOT a prop: final-minute brightening arrives via a ref + CSS variable, so the
 *    background never re-renders while the clock runs.
 */
export interface BgProps { effects: boolean; motion: boolean; particles: boolean; scanlines: boolean; burst: number; intensityRef: React.MutableRefObject<number> }

function BackgroundInner({ effects, motion, particles, scanlines, burst, intensityRef }: BgProps) {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div className="bg-base" />
      <div className="bg-heat" />
      {effects && (
        <>
          <div className="bg-glow" style={{ width: '46vw', height: '46vw', left: '-12vw', top: '-18vh', background: 'radial-gradient(circle, rgb(47 122 247 / 0.30) 0%, rgb(47 122 247 / 0.24) 35%, rgb(47 122 247 / 0.08) 58%, transparent 72%)' }} />
          <div className="bg-glow" style={{ width: '38vw', height: '38vw', right: '-10vw', bottom: '-20vh', background: 'radial-gradient(circle, rgb(240 194 55 / 0.14) 0%, rgb(240 194 55 / 0.10) 35%, rgb(240 194 55 / 0.03) 58%, transparent 72%)', animationDelay: '-9s' }} />
          <div className="bg-glow" style={{ width: '24vw', height: '24vw', right: '18vw', top: '-12vh', background: 'radial-gradient(circle, rgb(52 199 147 / 0.08) 0%, rgb(52 199 147 / 0.05) 40%, transparent 70%)', animationDelay: '-15s' }} />
        </>
      )}
      <FxCanvas motion={motion} particles={particles} burst={burst} intensityRef={intensityRef} />
      <div className={`fx-overlay ${scanlines ? 'scan' : ''}`} />
    </div>
  );
}
export const Background = memo(BackgroundInner);

// ---------------------------------------------------------------------------------------------
// Perspective grid — same geometry as the original CSS layers
// ---------------------------------------------------------------------------------------------
const PERSP = 700;
const THETA = (62 * Math.PI) / 180;
const SIN = Math.sin(THETA), COS = Math.cos(THETA);
const CELL = 80;
const LINE = 1.5;
const GRID_RGB = '73,92,133';
const PERIOD_MS = 6000;

/** Mask stops (position along the plane 0..1 → alpha) copied from the CSS mask-images. */
const floorMask = (f: number) => (f < 0.35 ? f / 0.35 : f < 0.7 ? 1 : Math.max(0, (1 - f) / 0.3));
const ceilMask = (f: number) => (f < 0.4 ? f / 0.4 : Math.max(0, (1 - f) / 0.6));

/**
 * Draw one perspective grid plane.
 *  edgeY  : screen y of the hinge edge (floor: its top edge, ceiling: its bottom edge)
 *  dir    : +1 floor (plane extends downward on screen), -1 ceiling (upward)
 *  phase  : 0..1 animation phase (lines move toward the viewer)
 */
function drawGrid(ctx: CanvasRenderingContext2D, W: number, H: number, edgeY: number, dir: 1 | -1, alpha: number, mask: (f: number) => number, phase: number) {
  const L = 0.62 * H; // element height
  const cx = W / 2;
  const scale = (v: number) => PERSP / (PERSP - v * SIN);
  const sy = (v: number) => edgeY + dir * v * COS * scale(v);
  const vMax = Math.min(L, (PERSP - 1) / SIN);
  const offset = phase * CELL;

  // Horizontal lines (constant depth v → a horizontal screen line; mask alpha is exact per line).
  for (let k = -1; k <= Math.ceil(L / CELL) + 1; k++) {
    const v = dir === 1 ? k * CELL + offset : L - (k * CELL + (CELL - offset));
    if (v < 0 || v > vMax) continue;
    const a = alpha * mask(v / L);
    if (a <= 0.003) continue;
    const s = scale(v);
    const y = sy(v);
    if (y < -4 || y > H + 4) continue;
    const half = W * s; // element is 2W wide, centred
    ctx.globalAlpha = a;
    ctx.fillRect(cx - half, dir === 1 ? y : y - LINE * COS * s, 2 * half, Math.max(0.6, LINE * COS * s));
  }

  // Vertical lines, drawn in depth segments so the mask fade follows the plane.
  const SEG = 18;
  for (let j = 0; j <= (2 * W) / CELL; j++) {
    const X = j * CELL - W; // relative to centre
    for (let i = 0; i < SEG; i++) {
      const v0 = (i / SEG) * vMax, v1 = ((i + 1) / SEG) * vMax;
      const a = alpha * mask(((v0 + v1) / 2) / L);
      if (a <= 0.003) continue;
      const s0 = scale(v0), s1 = scale(v1);
      const x0 = cx + X * s0, x1 = cx + X * s1;
      if ((x0 < -10 && x1 < -10) || (x0 > W + 10 && x1 > W + 10)) continue;
      const y0 = sy(v0), y1 = sy(v1);
      if ((y0 < -10 && y1 < -10) || (y0 > H + 10 && y1 > H + 10)) continue;
      const w0 = (LINE * s0) / 2, w1 = (LINE * s1) / 2;
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.moveTo(x0 - w0, y0); ctx.lineTo(x0 + w0, y0); ctx.lineTo(x1 + w1, y1); ctx.lineTo(x1 - w1, y1);
      ctx.fill();
    }
  }
}

// ---------------------------------------------------------------------------------------------
type P = { x: number; y: number; vx: number; vy: number; r: number; a: number; c: string; life: number };
const COLORS = ['#7fb0ff', '#2f7af7', '#f0c237', '#f2df2b', '#ffffff', '#34c793'];
const AMBIENT = 60;
const MAX_BURST = 320;

function FxCanvas({ motion, particles, burst, intensityRef }: { motion: boolean; particles: boolean; burst: number; intensityRef: React.MutableRefObject<number> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const parts = useRef<P[]>([]);
  const kick = useRef<() => void>(() => {});

  // Celebration burst (bounded: never more than MAX_BURST live particles).
  useEffect(() => {
    if (!burst || !particles) return;
    const w = window.innerWidth, h = window.innerHeight;
    const n = Math.max(0, Math.min(260, MAX_BURST - parts.current.length));
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 9;
      parts.current.push({
        x: w / 2, y: h * 0.45, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 2,
        r: 1.5 + Math.random() * 3.5, a: 1, c: COLORS[i % COLORS.length], life: 1,
      });
    }
    kick.current();
  }, [burst, particles]);

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d', { alpha: true });
    if (!cv || !ctx) return;
    if (!particles) parts.current = [];
    let raf = 0, w = 0, h = 0, running = false, last = 0, frameNo = 0;
    let ambient: P[] = [];
    const seed = () => {
      ambient = particles ? Array.from({ length: AMBIENT }, () => ({
        x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.15, vy: -0.1 - Math.random() * 0.35,
        r: 0.6 + Math.random() * 1.8, a: 0.15 + Math.random() * 0.5, c: COLORS[Math.floor(Math.random() * 3)], life: -1,
      })) : [];
    };
    const draw = (t: number, dt: number) => {
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, w, h);
      const phase = motion ? (t % PERIOD_MS) / PERIOD_MS : 0;
      ctx.fillStyle = `rgb(${GRID_RGB})`;
      drawGrid(ctx, w, h, 0.52 * h, -1, 0.38 * 0.25, ceilMask, phase);
      drawGrid(ctx, w, h, 0.48 * h, 1, 0.38 * 0.75, floorMask, phase);
      if (!particles) { ctx.globalAlpha = 1; return; }
      ctx.globalCompositeOperation = 'lighter';
      const intensity = intensityRef.current;
      const boost = 1 + intensity * 2.2;
      for (const p of ambient) {
        if (motion) {
          p.x += p.vx * dt * boost; p.y += p.vy * dt * boost;
          if (p.y < -10) { p.y = h + 10; p.x = Math.random() * w; }
          if (p.x < -10) p.x = w + 10; else if (p.x > w + 10) p.x = -10;
        }
        ctx.globalAlpha = Math.min(1, p.a * (0.8 + intensity));
        ctx.fillStyle = p.c;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      const list = parts.current;
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.06;
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.life -= 0.006 * dt;
        if (p.life <= 0 || p.y > h + 40) { list[i] = list[list.length - 1]; list.pop(); continue; }
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.c;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    const resize = () => {
      w = window.innerWidth; h = window.innerHeight;
      cv.width = w; cv.height = h; // DPR 1: projectors are 1×; keeps the per-frame upload bounded
      seed();
      draw(performance.now(), 0);
    };
    const frame = (t: number) => {
      const bursting = parts.current.length > 0;
      if (!motion && !bursting) { running = false; return; } // static: drawn once, loop stops
      raf = requestAnimationFrame(frame);
      frameNo++;
      if (!bursting && frameNo % 2) return; // ambient at 30 fps
      const dt = last ? Math.min(3, (t - last) / 16.7) : 1;
      last = t;
      draw(t, dt);
    };
    const play = () => {
      if (running || document.visibilityState !== 'visible') return;
      if (!motion && parts.current.length === 0) { draw(performance.now(), 0); return; }
      running = true; last = 0; raf = requestAnimationFrame(frame);
    };
    const stop = () => { running = false; cancelAnimationFrame(raf); };
    kick.current = play;
    const vis = () => (document.visibilityState === 'visible' ? play() : stop());
    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', vis);
    play();
    return () => { stop(); window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', vis); kick.current = () => {}; };
  }, [motion, particles, intensityRef]);

  return <canvas ref={ref} className="particles" aria-hidden />;
}
