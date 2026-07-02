/*
 * main.js — ENTRY POINT. Wires the whole app together and starts the loop.
 * =======================================================================
 * The app has two MODES sharing one fullscreen (transparent) canvas over the
 * page's animated gradient sky:
 *
 *   TRAIN  — a grid of training lanes. Several different creatures each train
 *            in their own viewport cell (LaneManager). Every frame we advance
 *            each lane's Trainer `speed` times (via the fixed-timestep Loop)
 *            and repaint the grid.
 *
 *   EDITOR — draw a creature (bodies + limited hinges) and spawn it into a new
 *            lane (Editor).
 *
 * The Sidebar (frosted glass) wires all the controls, the lane/slot lists and
 * the focused-lane stats + reward graph. Storage handles save/load and file
 * export/import. planck is expected on window.planck (a plain <script> before
 * this module); we never import planck — the physics modules read the global.
 */

import { CONFIG } from './config.js';
import { defaultBiped } from './creature.js';
import { Loop } from './ui/loop.js';
import { Sidebar } from './ui/controls.js';
import { Editor } from './ui/editor.js';
import { LaneManager } from './app/lanes.js';

// --- Canvas & context ---------------------------------------------------
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('sim'));
const ctx = canvas.getContext('2d');

// Shared app state (mode is read every frame by the render dispatcher).
const app = { mode: 'train' };

// Current CSS-pixel viewport (kept in sync by resize()).
let viewW = window.innerWidth;
let viewH = window.innerHeight;

const lanes = new LaneManager();
const editor = new Editor({
  onSpawn: (creature) => {
    const lane = sidebar._addLane(creature, { name: creature.name });
    if (lane) {
      sidebar.setMode('train'); // jump to the grid to watch it train
      sidebar.closeDrawer(); // on mobile, reveal the canvas
    }
  },
  onMessage: (msg, kind) => sidebar.setMsg(msg, kind),
});

/**
 * resize() — match the canvas backing store to viewport * devicePixelRatio,
 * keep CSS size at 100vw/100vh, reset the transform so we draw in CSS pixels,
 * and propagate the new size to the lane grid and the editor.
 */
function resize() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  canvas.style.width = viewW + 'px';
  canvas.style.height = viewH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lanes.setViewport(viewW, viewH);
  editor.setViewport(viewW, viewH);
}
window.addEventListener('resize', resize);
// Phones fire orientationchange (and shift the visual viewport as the URL bar
// shows/hides) without always firing a timely 'resize' — recompute size + DPR
// on those too so the canvas stays crisp and correctly sized.
window.addEventListener('orientationchange', resize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
resize();

// --- Loop ---------------------------------------------------------------
// onStep advances every lane's trainer ONE control step; the Loop calls it
// `speed` times per frame (so speed == control-steps-per-frame per lane).
// onRender clears the transparent canvas and paints the active mode.
const loop = new Loop(
  () => {
    if (app.mode === 'train') lanes.tickAll();
  },
  () => {
    ctx.clearRect(0, 0, viewW, viewH);
    if (app.mode === 'editor') editor.draw(ctx);
    else lanes.draw(ctx);
    sidebar.updateHud();
  }
);

// --- Sidebar (needs lanes, editor, loop, app) ---------------------------
const sidebar = new Sidebar({ laneManager: lanes, editor, loop, app });

// --- Pointer routing ----------------------------------------------------
// In EDITOR mode the canvas drives the editor (draw/drag). In TRAIN mode a
// click focuses the lane under the cursor.
function cssXY(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
// Non-passive so preventDefault() actually suppresses touch scrolling/zoom on
// the canvas (belt-and-suspenders with canvas { touch-action: none }). A finger
// wobbles more than a mouse, so the tap-vs-drag threshold is generous.
const TAP_SLOP = 12; // px of movement still counted as a tap-to-focus
let downXY = null;
canvas.addEventListener(
  'pointerdown',
  (e) => {
    e.preventDefault();
    const { x, y } = cssXY(e);
    if (app.mode === 'editor') {
      editor.onPointerDown(x, y);
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    } else {
      downXY = { x, y };
    }
  },
  { passive: false }
);
canvas.addEventListener(
  'pointermove',
  (e) => {
    if (app.mode !== 'editor') return;
    e.preventDefault();
    const { x, y } = cssXY(e);
    editor.onPointerMove(x, y);
  },
  { passive: false }
);
canvas.addEventListener(
  'pointerup',
  (e) => {
    e.preventDefault();
    const { x, y } = cssXY(e);
    if (app.mode === 'editor') {
      editor.onPointerUp(x, y);
    } else if (downXY) {
      // Treat a near-stationary press/release as a click-to-focus (tap-safe).
      if (Math.hypot(x - downXY.x, y - downXY.y) < TAP_SLOP) {
        const id = lanes.hitTest(x, y);
        if (id != null) {
          lanes.focus(id);
          sidebar.refresh();
        }
      }
      downXY = null;
    }
  },
  { passive: false }
);
// If a touch/pointer is cancelled mid-gesture (e.g. system gesture), end any
// active editor drag cleanly instead of leaving a body "stuck" to the finger.
canvas.addEventListener('pointercancel', () => {
  if (app.mode === 'editor') editor.onPointerUp();
  downXY = null;
});

// --- Seed one lane and go ----------------------------------------------
sidebar._addLane(defaultBiped(), { name: 'Default Biped' });
loop.start();

// Debug handles (harmless; this is a static toy).
window.walkSim = { lanes, editor, sidebar, loop, app, CONFIG };
