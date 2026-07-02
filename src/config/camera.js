/*
 * config/camera.js — training-camera framing tunables.
 * ------------------------------------------------------------------
 * How the per-lane chase camera smooths toward and vertically frames the
 * creature. Consumed by src/ui/camera.js. The barrel spreads this into CONFIG.
 */
export const cameraConfig = Object.freeze({
  // --- Camera ------------------------------------------------------------
  camera: Object.freeze({
    lerp: 0.08, // 0..1 smoothing factor when chasing the root's x.
    // Vertical framing: how far above the ground (in meters) the camera's
    // focus sits, so the creature is comfortably in view.
    focusHeight: 1.6,
  }),
});
