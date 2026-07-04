/*
 * scenery.js — motion cues: a MUYBRIDGE-STYLE CALIBRATED MOTION FIELD.
 * =====================================================================
 * Pure drawing, called from render/core.js INSIDE the cell clip, so everything
 * here is drawn on top of the page's static study-plate sky and is clipped to
 * (and framed by) each lane's rounded cell — exactly like the bodies. Nothing
 * here touches physics; it only reads a Camera and CONFIG.
 *
 * The world is styled as the gridded, numbered wall Eadweard Muybridge shot his
 * walking animals against — a measured biomechanics field, NOT a landscape. Two
 * jobs, both meant to make it obvious the walker is TRAVELLING:
 *
 *   1. drawParallax(ctx, camera) — the CALIBRATED BACKDROP (call BEFORE the
 *      ground band + creature). A scrolling vertical meter grid (every 1m, bold
 *      every 5m) plus faint horizontal reference lines at whole-meter heights —
 *      the measurement wall. Everything is pinned to WORLD x with the REAL
 *      camera (parallax factor 1), so the grid is "painted on the field" and
 *      scrolls past as the camera chases the root. That scroll IS the travel cue.
 *
 *   2. drawDistanceMarkers(ctx, camera) — regularly spaced ground ticks + "Nm"
 *      labels pinned to WORLD x (a START line at x=0, majors every
 *      `markerInterval`, minors every `markerMinor`), plus milestone pennant
 *      flags every 10m (the ONE amber accent). Also drawn with the real camera
 *      (factor 1) so ticks sit exactly on the ground.
 *
 * MAPPING (see layerScreenX): the real camera maps world x with
 *   screenX = offsetX + viewW/2 + (worldX - focusX) * ppm.
 * A layer can swap the real focus for a scaled one (factor):
 *   screenX = offsetX + viewW/2 + (worldX - focusX*factor) * ppm.
 * The backdrop uses factor 1 throughout (painted on the field). We keep ppm (and
 * the y mapping) identical to the real camera so the grid stands on the same
 * ground line and scales like the creature.
 *
 * DETERMINISM: every mark lives at a FIXED world position (integer meters). We
 * only visit the meter indices whose world x is on screen (culled from the
 * camera), so the loops are small and bounded, and the field looks identical
 * every frame — no Math.random, no per-frame state, no flicker.
 */

import { CONFIG } from './config.js';

/**
 * layerScreenX(camera, worldX, factor) — the parallax x mapping.
 * Identical to camera.worldToScreen's x, but with the focus scaled by `factor`
 * so the layer drifts at rate `factor` relative to the real world. The backdrop
 * uses factor 1 (fully world-locked); the helper is kept general.
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
 * over on-screen marks (never thousands). `marginM` pads the range in meters so
 * marks wider than one tile don't pop in/out at the cell edges.
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
 * FEATURE 2 — the calibrated motion field (call BEFORE the ground band +
 * creature). Draws back-to-front: far-horizon band -> horizontal wall lines ->
 * vertical meter grid. All pinned to world x (factor 1) so it scrolls past.
 * ======================================================================== */
export function drawParallax(ctx, camera) {
  const G = CONFIG.scenery.grid;
  drawHorizon(ctx, camera, G); // faint flat depth hint, furthest back
  drawWallLines(ctx, camera, G); // horizontal whole-meter height references
  drawMeterGrid(ctx, camera, G); // vertical 1m gridlines, bold every Nth
}

/**
 * A single faint, flat far-horizon band spanning the cell width, a low hint of
 * depth behind the grid. Positioned by a fraction of the cell height so it sits
 * regardless of where the ground line falls. Deliberately minimal and flat —
 * no mounds, no gradient sprawl.
 */
function drawHorizon(ctx, camera, G) {
  if (!G.horizonColor) return; // horizon band is optional
  const ox = camera.offsetX || 0;
  const oy = camera.offsetY || 0;
  const y = oy + camera.viewH * G.horizonFrac; // band center, px down the cell

  ctx.save();
  ctx.fillStyle = G.horizonColor;
  ctx.fillRect(ox, y - G.horizonH / 2, camera.viewW, G.horizonH);
  ctx.restore();
}

/**
 * Horizontal "measurement wall" reference lines at whole-meter HEIGHTS above the
 * ground line (1m, 2m, 3m…), thin and very faint, spanning the cell width — the
 * calibrated wall the specimen is measured against. Screen-up is negative y, so
 * a height h meters above the ground is groundY - h*ppm (matches how bodies
 * measure up from the ground).
 */
function drawWallLines(ctx, camera, G) {
  const ox = camera.offsetX || 0;
  const oy = camera.offsetY || 0;
  const groundY = camera.worldToScreen(0, CONFIG.ground.y).y;

  ctx.save();
  ctx.strokeStyle = G.wallColor;
  ctx.lineWidth = G.wallWidth;
  for (const h of G.wallHeights) {
    const y = groundY - h * camera.ppm; // px height above the ground line
    if (y < oy) continue; // above the top of the cell -> skip (cull)
    // Half-pixel snap keeps a 1px line crisp instead of blurring over two rows.
    const sy = Math.round(y) + 0.5;
    ctx.beginPath();
    ctx.moveTo(ox, sy);
    ctx.lineTo(ox + camera.viewW, sy);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The vertical METER GRID: a faint line at every 1m of world x rising from the
 * ground line to the top of the cell, with every Nth meter (majorEvery) drawn
 * BOLDER/darker — the numbered gridlines on Muybridge's backdrop wall. Pinned to
 * world x with the real camera (factor 1) so the whole grid scrolls past as the
 * walker travels; that scroll is the primary travel cue.
 */
function drawMeterGrid(ctx, camera, G) {
  const oy = camera.offsetY || 0;
  const groundY = camera.worldToScreen(0, CONFIG.ground.y).y;
  const topY = oy; // grid rises to the top edge of the cell

  // Visible world-x span for the REAL camera (factor 1): only draw within it.
  const halfW = camera.viewW / 2 / camera.ppm;
  const minWX = camera.focusX - halfW;
  const maxWX = camera.focusX + halfW;

  // Every `minorEvery` meters is a line; every `majorEvery` meters is bold.
  const step = G.minorEvery; // meters between vertical lines
  const majorMod = Math.max(1, Math.round(G.majorEvery / G.minorEvery)); // e.g. 5
  const firstN = Math.floor(minWX / step);
  const lastN = Math.ceil(maxWX / step);

  ctx.save();
  for (let n = firstN; n <= lastN; n++) {
    const wx = n * step;
    const isMajor = n % majorMod === 0;
    const sx = Math.round(layerScreenX(camera, wx, 1)) + 0.5; // crisp 1px line
    ctx.strokeStyle = isMajor ? G.majorColor : G.minorColor;
    ctx.lineWidth = isMajor ? G.majorWidth : G.minorWidth;
    ctx.beginPath();
    ctx.moveTo(sx, groundY);
    ctx.lineTo(sx, topY);
    ctx.stroke();
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
 * (10m, 20m, …), the ONE bold accent in the field (it echoes the UI's amber).
 * Each flag is a thin pole rising from the ground line with a small triangular
 * pennant near its top, labelled with the distance. Pinned to fixed world x and
 * drawn with the REAL camera (factor 1) so the poles stand exactly on the ground
 * and scroll past with the world. Determinism: fixed world positions, no state.
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
