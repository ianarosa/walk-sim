/*
 * scenery.js — motion cues: a flat, art-directed PARALLAX LANDSCAPE + ground
 * distance markers. Screen-print / cut-paper aesthetic (NOT clip-art).
 * =====================================================================
 * Pure drawing, called from render/core.js INSIDE the cell clip, so everything
 * here is drawn on top of the page's static muted-daylight sky and is clipped to
 * (and framed by) each lane's rounded cell — exactly like the bodies. Nothing
 * here touches physics; it only reads a Camera and CONFIG.
 *
 * Two jobs, both meant to make it obvious the walker is TRAVELLING:
 *
 *   1. drawParallax(ctx, camera) — a layered landscape drawn back-to-front:
 *      sun -> hills -> clouds -> trees -> bushes. Each layer is drawn through a
 *      VIRTUAL camera whose focus x = camera.focusX * factor. With factor 1 a
 *      layer moves fully with the world; with factor 0 it is pinned to the
 *      screen. Distant layers use a small factor so they barely drift while near
 *      ones sweep by — that difference in drift IS the sensation of motion.
 *
 *   2. drawDistanceMarkers(ctx, camera) — ground ticks + "Nm" labels + a START
 *      line at x=0, plus amber milestone pennants every 10m (the one accent).
 *      Drawn with the REAL camera (factor 1) so they sit exactly on the ground.
 *
 * ART DIRECTION (why it reads as designed, not AI clip-art): flat fills (no soft
 * radial blobs), a MUTED limited palette, and per-element VARIETY driven by a
 * deterministic hash — varied heights, widths, tilt, form and spacing jitter so
 * no two elements are identical. Clouds are sparse flat streaks (no puffy lobed
 * cumulus), trees are irregular two-form silhouettes in two depth rows, hills
 * are overlapping tonal bands (not repeated mounds).
 *
 * PARALLAX MATH (see layerScreenX): the real camera maps world x with
 *   screenX = offsetX + viewW/2 + (worldX - focusX) * ppm.
 * A layer just swaps the real focus for a scaled one:
 *   screenX = offsetX + viewW/2 + (worldX - focusX*factor) * ppm.
 * So when focusX moves by Δ, a layer's on-screen shift is Δ*factor*ppm — i.e.
 * proportional to factor. We keep ppm (and the y mapping) identical to the real
 * camera so trees stand on the same ground line and scale like the creature.
 *
 * DETERMINISM: each layer is a repeating FIELD. For each layer we only visit the
 * integer tile indices whose world x is on screen (culled from the camera), and
 * every per-object property (jitter, height, form, tilt) comes from hash01(tile,
 * salt) — a pure integer hash. No Math.random, no per-frame state: a given tile
 * looks identical every frame, so the field never flickers, yet it tiles/wraps
 * out to any x the creature can reach.
 */

import { CONFIG } from './config.js';

/* --------------------------------------------------------------------------
 * Deterministic hashing helpers.
 * hash01(n, salt) -> a stable pseudo-random float in [0,1) for integer inputs.
 * We fold a `salt` in so one tile index can yield several independent values
 * (x jitter, height, form, tilt, …) without correlating between them.
 * ------------------------------------------------------------------------ */
function hash01(n, salt = 0) {
  // Mix the tile index with the salt, then run a couple of xorshift/multiply
  // rounds (Math.imul keeps this 32-bit and identical across engines).
  let h = (n | 0) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h ^ (h >>> 4), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296; // 0xffffffff+1 -> normalize to [0,1)
}

/** Map a value in [0,1) onto [lo, hi]. */
function lerp(lo, hi, t) {
  return lo + (hi - lo) * t;
}

/**
 * layerScreenX(camera, worldX, factor) — the parallax x mapping.
 * Identical to camera.worldToScreen's x, but with the focus scaled by `factor`
 * so the layer drifts at rate `factor` relative to the real world.
 */
function layerScreenX(camera, worldX, factor) {
  return (
    (camera.offsetX || 0) +
    camera.viewW / 2 +
    (worldX - camera.focusX * factor) * camera.ppm
  );
}

/**
 * visibleTiles(camera, factor, spacing, marginM) — the inclusive [first,last]
 * tile-index range whose centers can appear in this cell, so callers loop only
 * over on-screen objects (never thousands). `marginM` pads the range in meters
 * so objects wider than one tile don't pop in/out at the cell edges.
 *
 * The layer's world center is focusX*factor; the cell shows ±(viewW/2)/ppm
 * meters around it. Tile i sits near x = i*spacing, hence the divisions below.
 */
function visibleTiles(camera, factor, spacing, marginM) {
  const halfW = camera.viewW / 2 / camera.ppm; // half the cell width, in meters
  const centerWX = camera.focusX * factor; // this layer's world-x center
  const minWX = centerWX - halfW - marginM;
  const maxWX = centerWX + halfW + marginM;
  return {
    first: Math.floor(minWX / spacing),
    last: Math.ceil(maxWX / spacing),
  };
}

/* ==========================================================================
 * FEATURE 2 — parallax landscape (call BEFORE the ground band + creature).
 * Draws back-to-front: sun -> hills -> clouds -> trees -> bushes.
 * ======================================================================== */
export function drawParallax(ctx, camera) {
  const S = CONFIG.scenery;
  drawSun(ctx, camera, S.sun); // furthest of all — behind the hills
  drawHills(ctx, camera, S.hills); // overlapping tonal bands
  drawClouds(ctx, camera, S.clouds); // sparse flat streaks
  drawTrees(ctx, camera, S.trees); // two irregular depth rows
  drawBushes(ctx, camera, S.bushes); // low flat clumps
}

/**
 * SUN — a single clean FLAT pale disc with ONE gentle radial halo (no rings).
 * Anchored to a fixed world x so there's exactly one sun; the tiny parallax
 * `factor` still gives it a barely-perceptible drift so it reads as very
 * distant. Sits high in the cell by a fraction of the cell height.
 */
function drawSun(ctx, camera, SUN) {
  const oy = camera.offsetY || 0;
  const cx = layerScreenX(camera, SUN.worldX, SUN.factor); // near-pinned drift
  const cy = oy + camera.viewH * SUN.topFrac; // high-sky vertical spot
  const r = SUN.radius * camera.ppm; // disc radius, px (meters × ppm)

  // Cull if the whole disc + its glow is off either side of the cell.
  const glowR = r * SUN.glowFrac; // outermost halo reach
  if (cx + glowR < 0 || cx - glowR > camera.viewW) return;

  ctx.save();
  // ONE soft halo: a single radial gradient warm at the disc edge fading to
  // transparent at glowR — smooth falloff, no concentric ring banding.
  const halo = ctx.createRadialGradient(cx, cy, r, cx, cy, glowR);
  halo.addColorStop(0, SUN.glowColor);
  halo.addColorStop(1, SUN.glowEdgeColor);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
  ctx.fill();

  // The clean flat pale disc on top.
  ctx.fillStyle = SUN.color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * HILLS — flat, overlapping TONAL BANDS (cut-paper depth), not repeated mounds.
 * Each config band is a long, low, gently-undulating ridge across the whole
 * visible span at its own parallax factor, base color and crest height. Back
 * bands are paler + higher; front bands are a touch darker + lower, so they
 * stack into layered depth. The ridge line is built from a few hashed control
 * heights so it undulates without looking like identical scoops.
 */
function drawHills(ctx, camera, H) {
  const groundY = camera.worldToScreen(0, CONFIG.ground.y).y;

  ctx.save();
  // Draw each band back-to-front (config order = far -> near).
  for (let b = 0; b < H.bands.length; b++) {
    const band = H.bands[b];
    // Sample the ridge on a fixed world grid so crests are stable + world-locked.
    const step = band.step; // meters between ridge control points
    const { first, last } = visibleTiles(camera, band.factor, step, step * 2);

    ctx.beginPath();
    // Start at the far-left, down at the ground line.
    const x0 = layerScreenX(camera, first * step, band.factor);
    ctx.moveTo(x0, groundY + 2);
    for (let i = first; i <= last; i++) {
      const wx = i * step;
      const sx = layerScreenX(camera, wx, band.factor);
      // Hashed crest height per control point -> a natural, non-uniform ridge.
      const hM = lerp(band.minH, band.maxH, hash01(i, band.salt));
      const sy = groundY - hM * camera.ppm;
      ctx.lineTo(sx, sy);
    }
    // Close down the right edge and along the ground.
    const xN = layerScreenX(camera, last * step, band.factor);
    ctx.lineTo(xN, groundY + 2);
    ctx.closePath();
    ctx.fillStyle = band.color;
    ctx.fill();
  }
  ctx.restore();
}

/**
 * CLOUDS — SPARSE, flat, soft-edged ELONGATED horizontal streaks (stratus), NOT
 * puffy stacked lobes. Each cloud is a single horizontal rounded lozenge with a
 * soft vertical alpha fade (top->transparent, bottom->transparent) so its edges
 * feather without any concave "beak" notch. Width/length/height vary per tile,
 * and a sparsity gate skips most tiles so the sky stays open.
 */
function drawClouds(ctx, camera, C) {
  const oy = camera.offsetY || 0;
  const bandTop = oy + camera.viewH * C.topFrac; // sky band, as cell fractions
  const bandH = camera.viewH * C.bandFrac;
  const { first, last } = visibleTiles(camera, C.factor, C.spacing, C.maxW);

  ctx.save();
  for (let i = first; i <= last; i++) {
    if (hash01(i, 40) > C.density) continue; // sparse: keep the sky open
    const jitter = (hash01(i, 41) - 0.5) * 2 * C.jitter;
    const wx = i * C.spacing + jitter;
    const cx = layerScreenX(camera, wx, C.factor);
    const cy = bandTop + hash01(i, 42) * bandH; // stable vertical spot in the band
    const w = lerp(C.minW, C.maxW, hash01(i, 43)) * camera.ppm; // streak length, px
    const h = lerp(C.minH, C.maxH, hash01(i, 44)) * camera.ppm; // streak thickness, px

    // Soft top/bottom fade so the flat streak feathers into the sky (no hard rim).
    const grad = ctx.createLinearGradient(0, cy - h / 2, 0, cy + h / 2);
    grad.addColorStop(0, C.edgeColor);
    grad.addColorStop(0.5, C.color);
    grad.addColorStop(1, C.edgeColor);
    ctx.fillStyle = grad;

    // A single horizontal capsule (rounded-end lozenge) — elongated, flat.
    roundedCapsule(ctx, cx, cy, w, h);
    ctx.fill();
  }
  ctx.restore();
}

/** A horizontal capsule centered at (cx,cy): a rect with semicircular caps. */
function roundedCapsule(ctx, cx, cy, w, h) {
  const r = h / 2;
  const left = cx - w / 2 + r;
  const right = cx + w / 2 - r;
  ctx.beginPath();
  ctx.arc(left, cy, r, Math.PI / 2, (Math.PI * 3) / 2);
  ctx.lineTo(right, cy - r);
  ctx.arc(right, cy, r, (Math.PI * 3) / 2, Math.PI / 2);
  ctx.lineTo(left, cy + r);
  ctx.closePath();
}

/**
 * TREES — VARIED, IRREGULAR flat silhouettes in TWO depth rows. Each tree picks
 * one of two forms from a hash: a rounded BROADLEAF (wide, low crown) or a
 * taller NARROW conifer-ish form. Height, crown width, a slight tilt and spacing
 * jitter all vary per tile, so the row never reads as a cloned cotton-ball line.
 * The back row is smaller/paler and set behind; the front row is larger/darker.
 */
function drawTrees(ctx, camera, T) {
  ctx.save();
  // Draw the paler BACK row first, then the darker FRONT row on top.
  drawTreeRow(ctx, camera, T, T.back, 0);
  drawTreeRow(ctx, camera, T, T.front, 100);
  ctx.restore();
}

/** One depth row of trees. `row` carries this row's factor/spacing/scale/colors. */
function drawTreeRow(ctx, camera, T, row, saltBase) {
  const groundY = camera.worldToScreen(0, CONFIG.ground.y).y;
  const { first, last } = visibleTiles(camera, row.factor, row.spacing, T.maxH * 2);

  for (let i = first; i <= last; i++) {
    if (hash01(i, saltBase + 1) > row.density) continue; // sparser, natural gaps
    const jitter = (hash01(i, saltBase + 2) - 0.5) * 2 * row.jitter;
    const wx = i * row.spacing + jitter;
    const cx = layerScreenX(camera, wx, row.factor);
    const heightM = lerp(T.minH, T.maxH, hash01(i, saltBase + 3)) * row.scale;
    const hpx = heightM * camera.ppm;
    const tilt = (hash01(i, saltBase + 4) - 0.5) * T.maxTilt; // radians, slight lean
    const isConifer = hash01(i, saltBase + 5) < T.coniferFrac; // two distinct forms

    const trunkH = hpx * (isConifer ? 0.16 : 0.34); // conifer trunk shorter
    const trunkW = Math.max(1.5, hpx * 0.06);

    ctx.save();
    // Lean the whole tree slightly about its base — kills the ruler-straight row.
    ctx.translate(cx, groundY);
    ctx.rotate(tilt);

    // Trunk (flat muted brown).
    ctx.fillStyle = row.trunkColor;
    ctx.fillRect(-trunkW / 2, -trunkH, trunkW, trunkH);

    ctx.fillStyle = row.canopyColor;
    if (isConifer) {
      // Tall NARROW form: a slim triangular crown (flat fill, asymmetric width).
      const halfW = hpx * lerp(0.16, 0.24, hash01(i, saltBase + 6));
      ctx.beginPath();
      ctx.moveTo(0, -hpx); // apex
      ctx.lineTo(-halfW, -trunkH); // left base
      ctx.lineTo(halfW * 0.9, -trunkH); // right base (slightly asymmetric)
      ctx.closePath();
      ctx.fill();
    } else {
      // Rounded BROADLEAF form: a low wide crown as a single flat ellipse whose
      // radii differ (asymmetric), sat on the trunk top — no lobed blob stack.
      const crownR = hpx * lerp(0.30, 0.40, hash01(i, saltBase + 7));
      const crownCy = -trunkH - crownR * 0.72;
      const rx = crownR * lerp(1.05, 1.35, hash01(i, saltBase + 8)); // wider than tall
      const ry = crownR * lerp(0.78, 0.95, hash01(i, saltBase + 9));
      ctx.beginPath();
      ctx.ellipse(0, crownCy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/**
 * BUSHES — low, flat, irregular clumps, sparse and muted, just in front of the
 * trees. Each is a single flat wide ellipse (a low mound) with varied width and
 * height and a sparsity gate, so they scatter rather than line up.
 */
function drawBushes(ctx, camera, B) {
  const groundY = camera.worldToScreen(0, CONFIG.ground.y).y;
  const { first, last } = visibleTiles(camera, B.factor, B.spacing, B.maxW);

  ctx.save();
  ctx.fillStyle = B.color;
  for (let i = first; i <= last; i++) {
    if (hash01(i, 60) > B.density) continue; // sparse scatter
    const jitter = (hash01(i, 61) - 0.5) * 2 * B.jitter;
    const wx = i * B.spacing + jitter;
    const cx = layerScreenX(camera, wx, B.factor);
    const wM = lerp(B.minW, B.maxW, hash01(i, 62));
    const hM = lerp(B.minH, B.maxH, hash01(i, 63));
    const rx = (wM / 2) * camera.ppm; // clump half-width, px
    const ry = hM * camera.ppm; // clump height, px

    // A single low flat mound sitting on the ground line (flat fill, no lobes).
    ctx.beginPath();
    ctx.ellipse(cx, groundY, rx, ry, 0, Math.PI, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* ==========================================================================
 * FEATURE 1 — ground distance markers (call AFTER the ground band, so the
 * ticks read on top of it, but BEFORE the creature bodies).
 * ======================================================================== */
export function drawDistanceMarkers(ctx, camera) {
  const S = CONFIG.scenery;
  const groundY = camera.worldToScreen(0, CONFIG.ground.y).y;

  // Visible world-x span for the REAL camera (factor 1): only tick within it.
  const halfW = camera.viewW / 2 / camera.ppm;
  const minWX = camera.focusX - halfW;
  const maxWX = camera.focusX + halfW;

  // In tiny/zoomed-out cells the minor ticks + labels turn to noise, so below a
  // PPM threshold we draw ONLY the major ticks and the start line.
  const detailed = camera.ppm >= S.markerLabelMinPPM;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.font = S.markerLabelFont;

  // Walk minor-tick multiples across the visible span (a small, bounded loop).
  const step = S.markerMinor;
  const firstK = Math.floor(minWX / step);
  const lastK = Math.ceil(maxWX / step);
  const majorEvery = Math.round(S.markerInterval / S.markerMinor); // e.g. 2

  for (let k = firstK; k <= lastK; k++) {
    const wx = k * step;
    const isMajor = k % majorEvery === 0;
    const isStart = k === 0; // x=0 gets the distinct START line
    if (!detailed && !isMajor) continue; // skip minor clutter when zoomed out

    const sx = layerScreenX(camera, wx, 1); // real camera => exact ground x
    if (isStart) {
      // START line: taller, bold charcoal/sepia, with a small "START" cap.
      ctx.strokeStyle = S.startLineColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, groundY - 4);
      ctx.lineTo(sx, groundY + S.startLineTickH);
      ctx.stroke();
      ctx.lineWidth = 1;
      if (detailed) {
        ctx.fillStyle = S.startLineColor;
        ctx.fillText('START', sx, groundY - 6);
      }
      continue;
    }

    // Regular tick dropping below the ground line; majors are longer/darker.
    const tickH = isMajor ? S.markerMajorTickH : S.markerTickH;
    ctx.strokeStyle = isMajor ? S.markerMajorColor : S.markerMinorColor;
    ctx.beginPath();
    ctx.moveTo(sx, groundY);
    ctx.lineTo(sx, groundY + tickH);
    ctx.stroke();

    // Label majors with their distance ("1m", "2m", …) when there's room.
    if (isMajor && detailed) {
      const meters = Math.round(wx); // majors land on whole meters by design
      ctx.fillStyle = S.markerLabelColor;
      ctx.fillText(`${meters}m`, sx, groundY + tickH + 12);
    }
  }
  ctx.restore();

  // Milestone pennants on top of the ground band (still behind the creature).
  drawMilestones(ctx, camera);
}

/**
 * drawMilestones(ctx, camera) — an amber pennant flag every `interval` meters
 * (10m, 20m, …), the ONE bold accent in the landscape (it echoes the UI's
 * amber). Each flag is a thin pole rising from the ground line with a small
 * triangular pennant near its top, labelled with the distance. Pinned to fixed
 * world x and drawn with the REAL camera (factor 1) so the poles stand exactly
 * on the ground and scroll past. Determinism: fixed world positions, no state.
 */
function drawMilestones(ctx, camera) {
  const S = CONFIG.scenery;
  const M = S.milestones;
  const groundY = camera.worldToScreen(0, CONFIG.ground.y).y;

  // Same visible world-x span math as the markers above (real camera, factor 1).
  const halfW = camera.viewW / 2 / camera.ppm;
  const minWX = camera.focusX - halfW;
  const maxWX = camera.focusX + halfW;

  // Only the label text is gated by zoom; the pole+flag always draw.
  const detailed = camera.ppm >= S.markerLabelMinPPM;

  // Pole/flag sizes are meters × ppm so they scale with the creature.
  const poleH = M.poleH * camera.ppm; // pole height above the ground, px
  const flagW = M.flagW * camera.ppm; // pennant width (pole → tip), px
  const flagH = M.flagH * camera.ppm; // pennant height, px

  // Walk the whole-`interval` multiples across the visible span (bounded loop).
  const firstN = Math.floor(minWX / M.interval);
  const lastN = Math.ceil(maxWX / M.interval);

  ctx.save();
  ctx.lineWidth = 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.font = M.labelFont;

  for (let n = firstN; n <= lastN; n++) {
    if (n <= 0) continue; // skip x=0 (the START line owns it) and anything behind
    const wx = n * M.interval;
    const sx = layerScreenX(camera, wx, 1); // real camera => exact ground x
    const topY = groundY - poleH; // top of the pole

    // Thin vertical pole rising from the ground line.
    ctx.strokeStyle = M.poleColor;
    ctx.beginPath();
    ctx.moveTo(sx, groundY);
    ctx.lineTo(sx, topY);
    ctx.stroke();

    // Triangular amber pennant hanging off the top of the pole (points +x).
    ctx.fillStyle = M.flagColor;
    ctx.beginPath();
    ctx.moveTo(sx, topY); // pole top
    ctx.lineTo(sx + flagW, topY + flagH * 0.5); // outward tip
    ctx.lineTo(sx, topY + flagH); // back to pole
    ctx.closePath();
    ctx.fill();

    // Distance label above the pennant, in a slightly bolder/tinted style.
    if (detailed) {
      ctx.fillStyle = M.labelColor;
      ctx.fillText(`${Math.round(wx)}m`, sx, topY - 4);
    }
  }
  ctx.restore();
}

export default { drawParallax, drawDistanceMarkers };
