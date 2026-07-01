/*
 * ui/camera.js — a smooth 2D camera plus world<->screen helpers.
 * =============================================================
 * The camera tracks the creature's root along x with a lerp so motion feels
 * smooth. It also owns the coordinate conversion between planck's world
 * (METERS, y-UP) and the canvas (PIXELS, y-DOWN, origin top-left).
 *
 * The screen mapping, for a target CSS-pixel viewport {width, height}:
 *
 *   screenX = width  / 2 + (worldX - focusX) * PPM
 *   screenY = height * 0.72 - (worldY - 0)   * PPM     // y FLIPPED
 *
 * i.e. the camera's focus x sits at horizontal center, and world y=0 (the
 * ground) sits ~72% down the screen so there's room to look up at a
 * standing creature. Increasing worldY moves UP the screen (minus sign).
 */

import { CONFIG } from '../config.js';

export class Camera {
  constructor() {
    this.focusX = 0; // world x the camera is centered on (meters)
    this.viewW = 1; // current viewport width in CSS pixels
    this.viewH = 1; // current viewport height in CSS pixels
    // Fraction of screen height where world y=0 (ground) is drawn.
    this.groundFrac = 0.72;
  }

  /** call on resize; dimensions are CSS pixels (pre-DPR). */
  setViewport(width, height) {
    this.viewW = width;
    this.viewH = height;
  }

  /** smoothly chase a target world x (typically the root's x). */
  follow(targetX) {
    this.focusX += (targetX - this.focusX) * CONFIG.camera.lerp;
  }

  /** snap instantly (used on reset so the camera doesn't glide across). */
  snap(targetX) {
    this.focusX = targetX;
  }

  /** world (meters, y-up) -> screen (CSS pixels, y-down). */
  worldToScreen(wx, wy) {
    return {
      x: this.viewW / 2 + (wx - this.focusX) * CONFIG.PPM,
      y: this.viewH * this.groundFrac - wy * CONFIG.PPM,
    };
  }

  /** screen (CSS pixels, y-down) -> world (meters, y-up). */
  screenToWorld(sx, sy) {
    return {
      x: (sx - this.viewW / 2) / CONFIG.PPM + this.focusX,
      y: (this.viewH * this.groundFrac - sy) / CONFIG.PPM,
    };
  }
}

export default Camera;
