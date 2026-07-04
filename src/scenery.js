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
 * no two elements are identical. Clouds are sparse BOLD puffy cartoon cumulus
 * with a clean dark outline (comic/sticker style), trees are irregular two-form
 * silhouettes (broadleaf + layered fir) in two depth rows, hills are overlapping
 * tonal bands (not repeated mounds).
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
  drawClouds(ctx, camera, S.clouds); // sparse bold puffy outlined cumulus
  drawTrees(ctx, camera, S.trees); // two irregular depth rows
  drawBushes(ctx, camera, S.bushes); // low flat clumps
}

/**
 * SUN — a single pale disc with ONE gentle radial halo (no rings). The disc
 * itself carries a SUBTLE radial gradient (a hair-lighter warm cream core fading
 * to the rim cream) so it isn't a dead-flat fill, yet still reads as a hazy
 * distant sun, not a bright bulb. Anchored to a fixed world x so there's exactly
 * one sun; the tiny parallax `factor` still gives it a barely-perceptible drift
 * so it reads as very distant. Sits high in the cell by a fraction of height.
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

  // The pale disc on top — a SUBTLE radial gradient (hair-lighter warm cream
  // center -> the rim cream) so it isn't a dead-flat fill, staying hazy + muted.
  const disc = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  disc.addColorStop(0, SUN.coreColor);
  disc.addColorStop(1, SUN.color);
  ctx.fillStyle = disc;
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
 * CLOUDS — BOLD PUFFY CARTOON CUMULUS with a clean dark OUTER OUTLINE (comic /
 * sticker style). Each cloud is several overlapping CIRCLE lobes (see
 * cumulusLobes): a bumpy rounded multi-lobe top over a flatter bottom.
 *
 * The outline is the key to the look, and we get it WITHOUT stroking any circle
 * (which would leave messy internal arcs). Instead we use the INFLATED-SILHOUETTE
 * technique, TWO union fills per cloud:
 *   Pass 1 (outline): fill every lobe circle at radius (r + outlineW) — unioned
 *     in ONE path — with the dark slate color. This is a single blob slightly
 *     larger than the cloud.
 *   Pass 2 (body): fill every lobe circle at radius r — unioned in ONE path —
 *     with white. The white covers the interior, so the dark shows ONLY as a
 *     crisp band around the whole outer silhouette. No internal seams.
 * Each union is one path filled once, so overlapping lobes never double-darken.
 * A couple of SHORT, faint interior arcs then hint at lobe seams near the top.
 * A sparsity gate keeps these bold clouds from tiling densely.
 */
function drawClouds(ctx, camera, C) {
  const oy = camera.offsetY || 0;
  const bandTop = oy + camera.viewH * C.topFrac; // sky band, as cell fractions
  const bandH = camera.viewH * C.bandFrac;
  const { first, last } = visibleTiles(camera, C.factor, C.spacing, C.maxW);

  ctx.save();
  for (let i = first; i <= last; i++) {
    if (hash01(i, 40) > C.density) continue; // sparse: a bold cloud shouldn't tile densely
    const jitter = (hash01(i, 41) - 0.5) * 2 * C.jitter;
    const wx = i * C.spacing + jitter;
    const cx = layerScreenX(camera, wx, C.factor);
    const cy = bandTop + hash01(i, 42) * bandH; // stable vertical anchor in the band
    const w = lerp(C.minW, C.maxW, hash01(i, 43)) * camera.ppm; // overall width, px
    const h = lerp(C.minH, C.maxH, hash01(i, 44)) * camera.ppm; // overall height, px
    const outlineW = h * C.outlineFrac; // dark band thickness, px (scales with size)

    // Build this cloud's cumulus lobes (deterministic per tile).
    const { lobes, nBase } = cumulusLobes(i, cx, cy, w, h);

    // PASS 1 — OUTLINE: union every (r+outlineW) circle in ONE path, fill once,
    // so a single clean dark blob sits slightly larger than the cloud (no seams).
    ctx.fillStyle = C.outlineColor;
    ctx.beginPath();
    for (const L of lobes) {
      ctx.moveTo(L.x + L.r + outlineW, L.y); // fresh subpath (no chord between lobes)
      ctx.arc(L.x, L.y, L.r + outlineW, 0, Math.PI * 2);
    }
    ctx.fill();

    // PASS 2 — BODY: union every r circle in ONE path, fill white once. The white
    // covers the interior, leaving the dark showing ONLY as a crisp outer band.
    ctx.fillStyle = C.bodyColor;
    ctx.beginPath();
    for (const L of lobes) {
      ctx.moveTo(L.x + L.r, L.y);
      ctx.arc(L.x, L.y, L.r, 0, Math.PI * 2);
    }
    ctx.fill();

    // A couple of SHORT, faint interior arcs on the lobes flanking center — a
    // subtle hint of lobe seams near the top, kept few + faint so it stays clean.
    ctx.strokeStyle = C.accentColor;
    ctx.lineWidth = Math.max(1, outlineW * 0.55);
    const mid = Math.floor(nBase / 2);
    for (const k of [mid - 1, mid + 1]) {
      if (k < 0 || k >= nBase) continue;
      const L = lobes[k];
      ctx.beginPath();
      ctx.arc(L.x, L.y, L.r * 0.86, Math.PI * 1.15, Math.PI * 1.85); // short top cap
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * cumulusLobes(i, cx, cy, w, h) — the deterministic lobe layout for one cumulus.
 * Returns { lobes:[{x,y,r}], nBase }. BASELINE lobes span the width with their
 * BOTTOMS aligned near a common baseline (flat bottom) while their radii bulge
 * the top; central lobes are bigger, flanks smaller (a cumulus "bell"). Then 1–2
 * TOP BUMP lobes, inner and biased higher, give the bumpy crown. Every size and
 * offset comes from hash01 so clouds vary but never flicker.
 */
function cumulusLobes(i, cx, cy, w, h) {
  const hw = w / 2;
  const by = cy + h * 0.3; // common flatter BASELINE (lobe bottoms rest near here)
  const lobes = [];

  // Baseline lobes: bottoms ~ on `by` (flat bottom), radii bulge the top.
  const nBase = 3 + Math.round(hash01(i, 45) * 2); // 3..5 baseline lobes
  for (let k = 0; k < nBase; k++) {
    const t = nBase <= 1 ? 0.5 : k / (nBase - 1); // 0..1 across the width
    const bell = 1 - Math.abs(t - 0.5) * 0.9; // ~0.55 (edge) .. 1 (center)
    const r = h * lerp(0.3, 0.46, hash01(i, 50 + k)) * lerp(0.78, 1.0, bell);
    const x = cx + lerp(-hw * 0.8, hw * 0.8, t) + (hash01(i, 60 + k) - 0.5) * h * 0.18;
    const y = by - r * lerp(0.82, 0.96, hash01(i, 70 + k)); // bottom near the baseline
    lobes.push({ x, y, r });
  }

  // 1–2 top bump lobes for the bumpy crown: inner, higher, a touch smaller.
  const nTop = 1 + Math.round(hash01(i, 46)); // 1..2 bumps
  for (let k = 0; k < nTop; k++) {
    const t = lerp(0.3, 0.7, hash01(i, 80 + k));
    const r = h * lerp(0.26, 0.38, hash01(i, 85 + k));
    const x = cx + lerp(-hw * 0.45, hw * 0.45, t);
    const y = by - h * lerp(0.55, 0.78, hash01(i, 90 + k)) - r * 0.2; // up near the crown
    lobes.push({ x, y, r });
  }

  return { lobes, nBase };
}

/**
 * TREES — VARIED, IRREGULAR flat silhouettes in TWO depth rows. Each tree picks
 * one of two forms from a hash: a rounded BROADLEAF (wide, low crown, with a
 * subtle darker inner lobe for a hint of volume) or a small layered FIR built
 * from 2–3 stacked triangular tiers. Height, crown width, a slight tilt and
 * spacing jitter all vary per tile, so the row never reads as a cloned line. The
 * back row is smaller/paler and set behind; the front row is larger/darker.
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
      // Small layered FIR: 2–3 stacked triangular tiers, bottom widest, each
      // upper tier narrower + higher, overlapping the one below into a fir
      // silhouette. All tiers go into ONE path filled ONCE, so overlaps union at
      // a single flat alpha (no darkening seams). Coords: y is negative upward,
      // so topY (apex) is the most-negative and baseY (foliage bottom) is higher.
      const tiers = Math.round(lerp(2, 3, hash01(i, saltBase + 6)));
      const topY = -hpx; // apex
      const baseY = -trunkH; // foliage sits on the trunk top
      const span = baseY - topY; // total foliage height (positive)
      const halfWBase = hpx * lerp(0.16, 0.24, hash01(i, saltBase + 7)); // widest tier
      ctx.beginPath();
      for (let t = 0; t < tiers; t++) {
        const segTop = topY + span * (t / tiers); // this tier's apex
        // Base drops a touch past the segment so tiers overlap (no gaps between).
        const drawBot = Math.min(baseY, topY + span * ((t + 1) / tiers) + span * 0.05);
        const halfW = halfWBase * lerp(0.5, 1.0, (t + 1) / tiers); // lower = wider
        ctx.moveTo(0, segTop); // apex
        ctx.lineTo(-halfW, drawBot); // left base
        ctx.lineTo(halfW * 0.92, drawBot); // right base (slightly asymmetric)
        ctx.closePath();
      }
      ctx.fill();
    } else {
      // Rounded BROADLEAF form: a low wide crown as a single flat ellipse whose
      // radii differ (asymmetric), sat on the trunk top — no lobed blob stack.
      // Slightly wider variety range so some crowns are rounder, some taller.
      const crownR = hpx * lerp(0.28, 0.42, hash01(i, saltBase + 7));
      const crownCy = -trunkH - crownR * 0.72;
      const rx = crownR * lerp(1.0, 1.42, hash01(i, saltBase + 8)); // wider than tall
      const ry = crownR * lerp(0.72, 1.02, hash01(i, saltBase + 9));
      ctx.beginPath();
      ctx.ellipse(0, crownCy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      // A slightly darker inner lobe, offset toward the lower-right, for a hint
      // of volume (a second flat tone) — kept subtle so the tree stays flat.
      ctx.fillStyle = row.canopyShadeColor;
      ctx.beginPath();
      ctx.ellipse(rx * 0.18, crownCy + ry * 0.30, rx * 0.68, ry * 0.60, 0, 0, Math.PI * 2);
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
