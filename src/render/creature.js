/*
 * render/creature.js — draw one dynamic body (a walker segment) as a soft,
 * rounded, gently-shadowed shape. A body may be a COMPOUND of several box
 * fixtures (the grid editor fuses adjacent cells into one body); we render it
 * as a SINGLE merged shape with NO internal seams.
 */

import { CONFIG } from '../config.js';
import { roundRectPath } from './shape.js';

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
export function drawBody(ctx, camera, body, fill, T) {
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
