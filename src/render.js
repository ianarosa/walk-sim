/*
 * render.js — draw a sim onto a 2D canvas, glass-on-gradient style.
 * ================================================================
 * Pure drawing: given a canvas context, a Sim, and a Camera, paint a soft
 * translucent lane "card", a gentle ground band, and every body as a rounded,
 * softly-shadowed segment. No physics mutation happens here.
 *
 * The canvas is TRANSPARENT over the page's animated gradient sky (main.js
 * clears it each frame with clearRect), so everything we paint is translucent
 * glass on top of that gradient — the physics view and the UI feel like one
 * cohesive frosted-glass design.
 *
 * GRID-AWARE: a Camera carries its own viewport RECT (offsetX/offsetY +
 * viewW/viewH, see camera.js). `drawSim` clips to a rounded version of that
 * rect so many lanes tile one canvas, each in its own glass cell. The classic
 * fullscreen path is just a camera with offset 0,0 covering the whole canvas;
 * `drawScene` is kept as a back-compat alias.
 *
 * World meters are converted to screen pixels via the camera (which applies
 * the y-flip and its own PPM). Colors/softness come from CONFIG.theme.
 */

import { CONFIG } from './config.js';
import { drawParallax, drawDistanceMarkers } from './scenery.js';

/** Path a rounded rectangle (uses native roundRect when present). */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, rr);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * drawSim(ctx, sim, camera) — render one sim into the camera's glass cell.
 * Assumes ctx is already scaled for devicePixelRatio (we draw in CSS pixels)
 * and that the canvas has been cleared for this frame by the caller.
 */
export function drawSim(ctx, sim, camera) {
  const T = CONFIG.theme;
  const ox = camera.offsetX || 0;
  const oy = camera.offsetY || 0;
  const inset = 4; // small gap so cells read as separate floating cards

  ctx.save();
  // Rounded translucent cell "card", clipped so lanes don't bleed together.
  roundRectPath(ctx, ox + inset, oy + inset, camera.viewW - 2 * inset, camera.viewH - 2 * inset, T.cellRadius);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = T.cellPanel;
  ctx.fillRect(ox, oy, camera.viewW, camera.viewH);

  // --- Parallax backdrop (behind the ground + creature) ---
  // Far hills -> clouds -> mid trees -> near bushes, each drifting at its own
  // rate so the creature visibly travels past a stable, deterministic field.
  drawParallax(ctx, camera);

  drawGround(ctx, camera, T);

  // --- Ground distance markers (on top of the ground band, behind bodies) ---
  // Fixed-world "Nm" ticks + a START line that scroll past as the camera chases
  // the root, giving a concrete read on how far the walker has gone.
  drawDistanceMarkers(ctx, camera);

  // --- Bodies (soft, rounded, gently shadowed) ---
  for (const [, body] of sim.bodies) {
    const ud = body.getUserData() || {};
    let color = T.limb;
    if (ud.isRoot) color = T.root;
    else if (ud.isFoot) color = T.foot;
    drawBody(ctx, camera, body, color, T);
  }

  // --- Joint markers (subtle) ---
  ctx.fillStyle = T.joint;
  for (const [, joint] of sim.joints) {
    const a = joint.getAnchorA();
    const s = camera.worldToScreen(a.x, a.y);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore(); // end clip

  // Glass edge around the cell.
  roundRectPath(ctx, ox + inset, oy + inset, camera.viewW - 2 * inset, camera.viewH - 2 * inset, T.cellRadius);
  ctx.strokeStyle = T.cellBorder;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// Back-compat name for callers that render a single fullscreen sim.
export const drawScene = drawSim;

/** Soft translucent ground band with a gentle highlight line. */
function drawGround(ctx, camera, T) {
  const gy = CONFIG.ground.y;
  const surfaceY = camera.worldToScreen(0, gy).y;
  const ox = camera.offsetX || 0;
  const oy = camera.offsetY || 0;
  const bottom = oy + camera.viewH;
  if (surfaceY < bottom) {
    const grad = ctx.createLinearGradient(0, surfaceY, 0, bottom);
    grad.addColorStop(0, T.groundBand);
    grad.addColorStop(1, 'rgba(255,255,255,0.02)');
    ctx.fillStyle = grad;
    ctx.fillRect(ox, surfaceY, camera.viewW, bottom - surfaceY);
  }
  ctx.strokeStyle = T.groundEdge;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ox, surfaceY);
  ctx.lineTo(ox + camera.viewW, surfaceY);
  ctx.stroke();
}

/**
 * Draw one dynamic body at its live transform. A body may be a COMPOUND of
 * several box fixtures (the grid editor fuses adjacent cells into one body);
 * we render it as a SINGLE merged shape with NO internal seams.
 *
 * Technique ("sticker outline"): working in the body's rotated frame,
 *   pass 1 — fill every fixture ENLARGED by a few px in the outline color
 *            (this becomes the uniform outer rim + casts one soft shadow), and
 *   pass 2 — fill every fixture at its true size in the body color.
 * Interior cell borders vanish because pass-2 fills abut exactly; only the
 * outer rim of pass-1 survives, giving a single soft rounded outline around
 * the whole silhouette. Single-fixture bodies get a fully rounded fill (their
 * classic look); multi-fixture bodies use sharp fills so cells stay seamless.
 */
function drawBody(ctx, camera, body, fill, T) {
  const pos = body.getPosition();
  const angle = body.getAngle();
  const ppm = camera.ppm;
  const c = camera.worldToScreen(pos.x, pos.y);

  // Collect fixture geometry in body-LOCAL meters (unrotated).
  const rects = [];
  const circles = [];
  for (let f = body.getFixtureList(); f; f = f.getNext()) {
    const shape = f.getShape();
    const type = shape.getType();
    if (type === 'circle') {
      const lc = shape.getCenter ? shape.getCenter() : shape.m_p;
      circles.push({ x: lc.x, y: lc.y, r: shape.getRadius() });
    } else if (type === 'polygon') {
      const verts = shape.m_vertices || (shape.getVertex && collectVerts(shape));
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      for (const v of verts) {
        if (v.x < minx) minx = v.x;
        if (v.x > maxx) maxx = v.x;
        if (v.y < miny) miny = v.y;
        if (v.y > maxy) maxy = v.y;
      }
      rects.push({
        cx: (minx + maxx) / 2,
        cy: (miny + maxy) / 2,
        w: (maxx - minx) * ppm,
        h: (maxy - miny) * ppm,
      });
    }
  }

  const k = 2; // outer rim thickness, px
  const roundFill = rects.length === 1; // single segment keeps its soft corners

  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(-angle); // world CCW -> screen CW (y-down); local +y is up

  // --- Pass 1: silhouette (outline color, enlarged) + one soft shadow ---
  ctx.save();
  ctx.shadowColor = T.shadow;
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = T.outline;
  for (const r of rects) {
    const x = r.cx * ppm - r.w / 2 - k;
    const y = -r.cy * ppm - r.h / 2 - k;
    const rad = Math.min(r.w, r.h) * CONFIG.theme.bodyRadiusFrac + k;
    roundRectPath(ctx, x, y, r.w + 2 * k, r.h + 2 * k, rad);
    ctx.fill();
  }
  for (const cc of circles) {
    ctx.beginPath();
    ctx.arc(cc.x * ppm, -cc.y * ppm, cc.r * ppm + k, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // --- Pass 2: body fill (no shadow, no internal seams) ---
  ctx.fillStyle = fill;
  for (const r of rects) {
    const x = r.cx * ppm - r.w / 2;
    const y = -r.cy * ppm - r.h / 2;
    const rad = roundFill ? Math.min(r.w, r.h) * CONFIG.theme.bodyRadiusFrac : 0;
    if (rad > 0) roundRectPath(ctx, x, y, r.w, r.h, rad);
    else { ctx.beginPath(); ctx.rect(x, y, r.w, r.h); }
    ctx.fill();
  }
  for (const cc of circles) {
    const sx = cc.x * ppm;
    const sy = -cc.y * ppm;
    const rpx = cc.r * ppm;
    ctx.beginPath();
    ctx.arc(sx, sy, rpx, 0, Math.PI * 2);
    ctx.fill();
    // Soft rotation spoke so spin is visible on a lone circle.
    ctx.strokeStyle = 'rgba(18,22,45,0.22)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + rpx, sy);
    ctx.stroke();
  }
  ctx.restore();
}

/** Collect polygon vertices when only getVertex(i)/m_count is available. */
function collectVerts(shape) {
  const out = [];
  const n = shape.m_count != null ? shape.m_count : shape.getVertexCount();
  for (let i = 0; i < n; i++) out.push(shape.getVertex(i));
  return out;
}

/** Rotate+translate a body-local point (lx,ly) into world space. */
function bodyPointToWorld(pos, angle, lx, ly) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    x: pos.x + (c * lx - s * ly),
    y: pos.y + (s * lx + c * ly),
  };
}

export default drawSim;
