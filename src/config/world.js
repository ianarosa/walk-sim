/*
 * config/world.js — physics-world & rendering-scale core tunables.
 * ------------------------------------------------------------------
 * The simulation-WIDE constants that are not tied to a single UI/render
 * domain: the pixels-per-meter scale, the planck.js (Box2D) world knobs
 * (gravity, fixed timestep, solver iteration counts), and the static ground.
 *
 * Coordinate note: planck.js is METERS, y-UP, with gravity in -y. The canvas
 * is PIXELS, y-DOWN. PPM is the scale factor; the y-flip lives in the render
 * transform.
 *
 * The barrel (src/config.js) spreads this object into the single shared CONFIG,
 * so these keys reach the rest of the code unchanged.
 */
export const worldConfig = Object.freeze({
  // --- Rendering scale ---------------------------------------------------
  PPM: 60, // pixels per meter. A 1m torso => 60px tall on screen.

  // --- Physics world -----------------------------------------------------
  // gravity is intentionally a plain (unfrozen) object literal, preserved from
  // the original monolith's shape.
  gravity: { x: 0, y: -10 }, // m/s^2, y-up: creatures fall in -y.
  dt: 1 / 60, // fixed physics timestep, seconds. Deterministic stepping.
  velIters: 8, // Box2D velocity constraint solver iterations per step.
  posIters: 3, // Box2D position constraint solver iterations per step.

  // --- Ground ------------------------------------------------------------
  ground: Object.freeze({
    y: 0, // world y of the ground surface, meters.
    halfWidth: 500, // half-length of the static ground box, meters.
    halfHeight: 5, // half-thickness; the top face sits at ground.y.
    friction: 0.9, // high friction so feet get traction.
  }),
});
