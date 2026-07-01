/*
 * ui/camera.js — a smooth 2D camera plus world<->screen helpers.
 * =============================================================
 * The camera tracks the creature's root along x with a lerp so motion feels
 * smooth. It also owns the coordinate conversion between planck's world
 * (METERS, y-UP) and the canvas (PIXELS, y-DOWN, origin top-left).
 *
 * GENERALIZED FOR THE GRID:
 * A camera no longer assumes it owns the whole canvas. It has a VIEWPORT rect
 * — an origin (offsetX, offsetY) plus a width/height, all in CSS pixels — so
 * many cameras can share one canvas, each drawing its own lane into its own
 * cell. A single-sim caller just passes offset 0,0 and the full viewport (the
 * original behavior). Each camera can also carry its own PPM so a small cell
 * can zoom out to fit a whole creature.
 *
 * The screen mapping, for this camera's rect {offsetX, offsetY, viewW, viewH}:
 *
 *   screenX = offsetX + viewW / 2      + (worldX - focusX) * ppm
 *   screenY = offsetY + viewH * gFrac  - (worldY - 0)      * ppm   // y FLIPPED
 *
 * i.e. the camera's focus x sits at the horizontal center of ITS cell, and
 * world y=0 (the ground) sits `groundFrac` down the cell. Increasing worldY
 * moves UP the screen (minus sign).
 */

import { CONFIG } from '../config.js';

export class Camera {
  constructor() {
    this.focusX = 0; // world x the camera is centered on (meters)
    this.viewW = 1; // this camera's cell width in CSS pixels
    this.viewH = 1; // this camera's cell height in CSS pixels
    this.offsetX = 0; // cell origin x on the canvas, CSS pixels
    this.offsetY = 0; // cell origin y on the canvas, CSS pixels
    this.ppm = CONFIG.PPM; // per-camera pixels-per-meter (cells may zoom out)
    // Fraction of the CELL height where world y=0 (ground) is drawn.
    this.groundFrac = 0.72;
  }

  /**
   * setViewport(width, height, offsetX?, offsetY?) — call on resize/layout.
   * All values are CSS pixels (pre-DPR). offsetX/offsetY default to 0 for the
   * classic fullscreen single-sim path.
   */
  setViewport(width, height, offsetX = 0, offsetY = 0) {
    this.viewW = width;
    this.viewH = height;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
  }

  /** override pixels-per-meter for this camera (used by grid cells to fit). */
  setPPM(ppm) {
    this.ppm = ppm;
  }

  /** smoothly chase a target world x (typically the root's x). */
  follow(targetX) {
    this.focusX += (targetX - this.focusX) * CONFIG.camera.lerp;
  }

  /** snap instantly (used on reset/spawn so the camera doesn't glide across). */
  snap(targetX) {
    this.focusX = targetX;
  }

  /** world (meters, y-up) -> screen (CSS pixels, y-down), in canvas space. */
  worldToScreen(wx, wy) {
    return {
      x: this.offsetX + this.viewW / 2 + (wx - this.focusX) * this.ppm,
      y: this.offsetY + this.viewH * this.groundFrac - wy * this.ppm,
    };
  }

  /** screen (CSS pixels, y-down) -> world (meters, y-up). */
  screenToWorld(sx, sy) {
    return {
      x: (sx - this.offsetX - this.viewW / 2) / this.ppm + this.focusX,
      y: (this.offsetY + this.viewH * this.groundFrac - sy) / this.ppm,
    };
  }
}

export default Camera;
