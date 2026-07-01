/*
 * app/lanes.js — the MULTI-BODY MANAGER.
 * ======================================
 * Several different creatures train at the same time, each in its own lane.
 *
 *   lane = {
 *     id:       number,          // unique, monotonic
 *     name:     string,          // shown in its cell + the sidebar
 *     creature: Creature,        // pristine plain-data body (for reset/save)
 *     trainer:  Trainer,         // owns its own Sim (trainer.sim), learns
 *     camera:   Camera,          // follows THIS lane's root in THIS cell
 *     error:    string|null,     // set if trainer.tick() ever throws
 *   }
 *
 * The manager lays the lanes out as a grid of viewport cells on the shared
 * canvas. Clicking a cell FOCUSES that lane: the focused lane gets a big cell
 * across the top and everyone else tiles into a thin strip along the bottom,
 * and the sidebar shows the focused lane's stats + reward graph.
 *
 * Each frame the owner calls `tickAll()` (advance every trainer one control
 * step — the fixed-timestep Loop multiplies this by the speed factor) and then
 * `draw(ctx)` (paint every cell). We never step physics directly here; the
 * Trainer owns stepping via `trainer.tick()`.
 *
 * RL CONTRACT (see src/rl/agent.js):
 *   new Trainer(sim)            -> infers obs/action sizes from the sim
 *   trainer.tick()              -> one control step; {reward,done,distance,episode}
 *   trainer.exploit (bool)      -> greedy (show best gait) when true
 *   trainer.episode / .bestDistance / .lastReturn / .returnHistory  (stats)
 *   trainer.serialize()         -> JSON-safe brain bundle
 *   Trainer.fromJSON(sim, json) -> restore a brain onto a matching sim (throws
 *                                  on size mismatch)
 */

import { Sim } from '../physics/sim.js';
import { Trainer } from '../rl/agent.js';
import { Camera } from '../ui/camera.js';
import { drawSim } from '../render.js';
import { validateCreature, cloneCreature } from '../creature.js';
import { CONFIG } from '../config.js';

let _nextId = 1;

export class LaneManager {
  constructor() {
    /** @type {Array<object>} */
    this.lanes = [];
    this.focusId = null; // id of the focused lane (big cell + sidebar stats)
    this.viewW = 1; // shared canvas size (CSS px)
    this.viewH = 1;
  }

  /** call on resize; CSS pixels. */
  setViewport(w, h) {
    this.viewW = w;
    this.viewH = h;
  }

  /**
   * addLane(creature, {name, brain}?) — build a Sim + Trainer for a creature
   * and append a lane. If `brain` is provided we try Trainer.fromJSON; on a
   * size mismatch we fall back to a fresh brain and return a `warn` string so
   * the caller can surface a friendly "body loaded, brain didn't fit" message.
   * Returns { lane, warn }.
   */
  addLane(creature, { name, brain } = {}) {
    validateCreature(creature);
    const c = cloneCreature(creature);
    const sim = new Sim(c);

    let trainer;
    let warn = null;
    if (brain) {
      try {
        trainer = Trainer.fromJSON(sim, brain);
      } catch (e) {
        warn = `brain didn't fit this body (${e.message || e}) — started a fresh one`;
        trainer = new Trainer(sim);
      }
    } else {
      trainer = new Trainer(sim);
    }

    const lane = {
      id: _nextId++,
      name: name || c.name || `Lane ${_nextId}`,
      creature: c,
      trainer,
      camera: new Camera(),
      error: null,
      // --- fall -> reset -> retry bookkeeping (see tickAll/draw) ---
      lastEpisode: trainer.episode != null ? trainer.episode : 0,
      pendingReset: false, // a tick() this frame returned {done:true}
      resetFlash: 0, // frames left to paint the "RESET" flash overlay
    };
    // Snap the camera onto the root so the cell doesn't glide in from x=0.
    try {
      lane.camera.snap(trainer.sim.rootPosition().x);
    } catch {
      /* sim not ready to query — harmless, follow() will catch up */
    }
    this.lanes.push(lane);
    if (this.focusId == null) this.focusId = lane.id;
    return { lane, warn };
  }

  /** removeLane(id) — drop a lane; re-focus another if we removed the focus. */
  removeLane(id) {
    this.lanes = this.lanes.filter((l) => l.id !== id);
    if (this.focusId === id) {
      this.focusId = this.lanes.length ? this.lanes[0].id : null;
    }
  }

  /** focus(id) — make a lane the big/focused one. */
  focus(id) {
    if (this.lanes.some((l) => l.id === id)) this.focusId = id;
  }

  /** the focused lane object (or the first, or null). */
  focusedLane() {
    return (
      this.lanes.find((l) => l.id === this.focusId) || this.lanes[0] || null
    );
  }

  laneById(id) {
    return this.lanes.find((l) => l.id === id) || null;
  }

  /**
   * resetLane(id) — restart a lane's learning: rebuild its Sim and hand it a
   * FRESH Trainer (new brain). The Trainer contract exposes no "reset episode
   * but keep brain" call, so reset == start over. (Documented assumption.)
   */
  resetLane(id) {
    const lane = this.laneById(id);
    if (!lane) return;
    const sim = new Sim(lane.creature);
    lane.trainer = new Trainer(sim);
    lane.error = null;
    lane.lastEpisode = sim && lane.trainer.episode != null ? lane.trainer.episode : 0;
    lane.pendingReset = false;
    lane.resetFlash = 0;
    lane.camera.snap(sim.rootPosition().x);
  }

  /** setExploit(id, on) — flip a lane's greedy/exploit flag. */
  setExploit(id, on) {
    const lane = this.laneById(id);
    if (lane) lane.trainer.exploit = !!on;
  }

  /**
   * tickAll() — advance every lane's trainer by one control step. Called by
   * the Loop's onStep, which fires it `speed` times per frame. A throwing
   * trainer is isolated (marked errored) so one bad lane can't freeze the
   * whole grid.
   */
  tickAll() {
    for (const lane of this.lanes) {
      if (lane.error) continue;
      try {
        const r = lane.trainer.tick();
        // The Trainer performs the physics reset itself on a fallen/timed-out
        // episode; we just note it so draw() can SHOW the snap-back clearly.
        if (r && r.done) lane.pendingReset = true;
      } catch (e) {
        lane.error = String(e.message || e);
      }
    }
  }

  // --- Layout -----------------------------------------------------------

  /**
   * _rects() — a rect {x,y,w,h} per lane (index-aligned to this.lanes).
   * Focused layout: the focused lane fills a big top region; the rest share a
   * thin strip along the bottom. With a single lane it just fills the canvas.
   */
  _rects() {
    const n = this.lanes.length;
    const W = this.viewW;
    const H = this.viewH;
    const rects = new Array(n);
    if (n === 0) return rects;
    if (n === 1) {
      rects[0] = { x: 0, y: 0, w: W, h: H };
      return rects;
    }
    const fi = this.lanes.findIndex((l) => l.id === this.focusId);
    if (fi >= 0) {
      const stripH = Math.min(180, H * 0.28);
      const mainH = H - stripH;
      rects[fi] = { x: 0, y: 0, w: W, h: mainH };
      const others = this.lanes.map((_, i) => i).filter((i) => i !== fi);
      const cw = W / others.length;
      others.forEach((i, k) => {
        rects[i] = { x: k * cw, y: mainH, w: cw, h: stripH };
      });
      return rects;
    }
    // Fallback: no focus set -> a near-square grid.
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cw = W / cols;
    const ch = H / rows;
    this.lanes.forEach((_, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      rects[i] = { x: c * cw, y: r * ch, w: cw, h: ch };
    });
    return rects;
  }

  /**
   * hitTest(sx, sy) — which lane id (if any) contains a canvas point. Used by
   * the click-to-focus handler.
   */
  hitTest(sx, sy) {
    const rects = this._rects();
    for (let i = 0; i < this.lanes.length; i++) {
      const r = rects[i];
      if (!r) continue;
      if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) {
        return this.lanes[i].id;
      }
    }
    return null;
  }

  // --- Draw -------------------------------------------------------------

  /** draw(ctx) — follow each root and paint every lane into its cell. */
  draw(ctx) {
    const rects = this._rects();
    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i];
      const r = rects[i];
      if (!r) continue;
      const cam = lane.camera;

      // Fit the creature vertically: choose a PPM that shows ~fitMeters of
      // world height in this cell, but never magnify past the global PPM.
      const ppm = Math.min(CONFIG.PPM, r.h / CONFIG.lanes.fitMeters);
      cam.setViewport(r.w, r.h, r.x, r.y);
      cam.setPPM(ppm);
      cam.groundFrac = CONFIG.lanes.groundFrac;

      const sim = lane.trainer.sim;

      // Detect a fall -> reset boundary two ways (a tick returned done, or the
      // episode counter advanced) and make it VISIBLE: the Trainer has already
      // snapped the body back to the start pose, so we SNAP the camera back to
      // the start x too (instead of gliding) and flash a "RESET" badge.
      const ep = lane.trainer.episode != null ? lane.trainer.episode : 0;
      const didReset = lane.pendingReset || ep !== lane.lastEpisode;
      if (didReset) {
        lane.pendingReset = false;
        lane.lastEpisode = ep;
        lane.resetFlash = 18; // ~0.3s of flash at 60fps
      }
      try {
        const rx = sim.rootPosition().x;
        if (didReset) cam.snap(rx);
        else cam.follow(rx);
      } catch {
        /* sim not ready — skip follow this frame */
      }

      drawSim(ctx, sim, cam);
      this._drawCellOverlay(ctx, lane, r);
    }
  }

  /** Per-cell overlay: name + attempts/best, focus edge, reset flash, error. */
  _drawCellOverlay(ctx, lane, r) {
    const T = CONFIG.theme;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();

    // Focus accent edge (the glass cell border itself is drawn by render.js).
    if (lane.id === this.focusId) {
      ctx.strokeStyle = T.focusBorder;
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 4.5, r.y + 4.5, r.w - 9, r.h - 9);
    }

    // A little frosted label chip with name + live stats.
    const t = lane.trainer;
    const ep = t.episode != null ? t.episode : 0;
    const best = t.bestDistance != null ? t.bestDistance : 0;
    ctx.fillStyle = 'rgba(10,14,40,0.35)';
    ctx.fillRect(r.x + 8, r.y + 8, Math.min(r.w - 16, 210), 34);
    ctx.fillStyle = T.label;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(lane.name, r.x + 16, r.y + 12);
    ctx.fillStyle = T.labelMuted;
    ctx.font = '11px system-ui, sans-serif';
    const line = lane.error
      ? `error: ${lane.error}`
      : `attempt ${ep}  ·  best ${Number(best).toFixed(2)}m` +
        (t.exploit ? '  ·  exploit' : '');
    ctx.fillText(line, r.x + 16, r.y + 26);

    // Fall -> reset flash: a brief translucent wash + "RESET" so the user can
    // SEE the retry loop each time the creature topples and snaps to start.
    if (lane.resetFlash > 0) {
      const a = lane.resetFlash / 18;
      ctx.fillStyle = `rgba(255,159,182,${0.16 * a})`;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = `rgba(255,159,182,${a})`;
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText('RESET', r.x + r.w - 62, r.y + 12);
      lane.resetFlash -= 1;
    }

    ctx.restore();
  }
}

export default LaneManager;
