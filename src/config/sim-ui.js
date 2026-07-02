/*
 * config/sim-ui.js — simulation-loop & flail-controller tunables.
 * ------------------------------------------------------------------
 * Two small presentation/driver knobs: the "flail" random-motor controller
 * (the non-RL default behavior) and the main render/step loop clamps.
 * Consumed by src/physics/sim.js and src/ui/loop.js. The barrel spreads this
 * into CONFIG (top-level keys `flail` and `loop`).
 */
export const simUiConfig = Object.freeze({
  // --- Flail controller (this slice's only "behavior") -------------------
  flail: Object.freeze({
    // Each step every motorized joint gets a random target speed in
    // [-range, +range] rad/s. Keeps joints visibly moving within limits.
    range: 6,
  }),

  // --- Loop --------------------------------------------------------------
  loop: Object.freeze({
    maxSpeed: 8, // max "physics steps per frame" the speed slider allows.
    maxAccumulatedSteps: 5, // clamp accumulator to avoid spiral-of-death.
  }),
});
