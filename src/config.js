/*
 * config.js — single source of truth for tunable constants.
 * ------------------------------------------------------------------
 * Everything that is a "magic number" anywhere else in the sim should
 * live here so the rest of the code reads declaratively. This is a
 * "barrel" module: it exports exactly one frozen CONFIG object.
 *
 * Coordinate note: planck.js (Box2D) is METERS, y-UP, with gravity
 * pointing in -y. The canvas is PIXELS, y-DOWN. PPM (pixels-per-meter)
 * is the scale factor; the y-flip is applied in the render transform.
 */

export const CONFIG = Object.freeze({
  // --- Rendering scale ---------------------------------------------------
  PPM: 60, // pixels per meter. A 1m torso => 60px tall on screen.

  // --- Physics world -----------------------------------------------------
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

  // --- Camera ------------------------------------------------------------
  camera: Object.freeze({
    lerp: 0.08, // 0..1 smoothing factor when chasing the root's x.
    // Vertical framing: how far above the ground (in meters) the camera's
    // focus sits, so the creature is comfortably in view.
    focusHeight: 1.6,
  }),

  // --- Colors (dark theme) ----------------------------------------------
  colors: Object.freeze({
    background: '#05070c',
    root: '#7cc4ff', // torso / root body
    foot: '#ffd166', // bodies flagged isFoot
    limb: '#c7cdd6', // every other dynamic body
    ground: '#1b2230',
    groundLine: '#2c3340', // top edge accent
    joint: '#ff6b8a', // little pivot dots
    outline: 'rgba(0,0,0,0.35)', // body stroke
  }),

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

  // --- Reinforcement-learning placeholder --------------------------------
  // Intentionally empty in this slice; the RL layer plugs in here later
  // (observation/action specs, reward weights, episode length, etc.).
  RL: Object.freeze({}),
});

export default CONFIG;
