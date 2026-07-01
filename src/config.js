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

  // --- Creature editor ---------------------------------------------------
  // The editor draws creatures in its OWN fixed screen<->meters mapping,
  // independent of the training camera (which pans/zooms). See editor.js for
  // the exact origin/PPM convention.
  editor: Object.freeze({
    ppm: 90, // editor pixels-per-meter. 90 => a 1m torso is 90px on screen.
    groundFrac: 0.72, // fraction of canvas height where world y=0 is drawn.
    grid: 0.1, // snap-to-grid increment, meters.
    minSize: 0.06, // smallest allowed body dimension, meters (guards specks).
    handleRadius: 0.7, // meters; radius at which joint limit handles/arc sit.
    hitPad: 8, // px slack when hit-testing handles/anchors with the pointer.
    defaultTorque: 80, // N*m default for a freshly-created joint's motor.
    maxTorque: 300, // upper bound of the torque slider.
  }),

  // --- Glass-on-gradient theme (UI + canvas) -----------------------------
  // Palette + softness knobs so the physics view matches the frosted-glass UI.
  // This is a presentation-only tunable; the physics never reads it.
  theme: Object.freeze({
    cellPanel: 'rgba(255,255,255,0.05)', // translucent card behind each lane
    cellBorder: 'rgba(255,255,255,0.16)', // hairline glass edge
    cellRadius: 18, // rounded corners for a lane cell, px
    focusBorder: 'rgba(143,211,255,0.85)', // focused-lane accent edge
    groundBand: 'rgba(255,255,255,0.12)', // soft translucent ground fill
    groundEdge: 'rgba(255,255,255,0.30)', // gentle ground highlight line
    root: '#8fd3ff', // torso / root body
    foot: '#ffd98a', // feet
    limb: '#e7ecff', // other limbs
    outline: 'rgba(18,22,45,0.28)', // soft body stroke
    joint: 'rgba(255,255,255,0.9)', // subtle joint markers
    shadow: 'rgba(10,14,40,0.30)', // drop shadow under bodies
    label: '#f4f7ff', // cell label text
    labelMuted: 'rgba(244,247,255,0.72)',
    accent: '#8fd3ff', // primary accent (matches CSS)
    reset: '#ff9fb6', // fall->reset flash tint
    bodyRadiusFrac: 0.32, // corner-round fraction of a segment's short side
  }),

  // --- Multi-lane training grid ------------------------------------------
  // Several creatures train side-by-side; each gets a viewport cell.
  lanes: Object.freeze({
    fitMeters: 4.6, // vertical meters a cell tries to show (sets its PPM).
    groundFrac: 0.82, // ground line sits low in a cell (room to stand up).
    maxLanes: 12, // sanity cap so the grid stays legible.
  }),

  // --- Reinforcement-learning hyperparameters ----------------------------
  // Consumed by src/rl/* (Trainer, policy, value, env). These are layered
  // UNDER any explicit config passed to `new Trainer(sim, config)` and OVER
  // the RL_DEFAULTS baked into agent.js, so overriding here is the norm.
  RL: Object.freeze({
    // Network / optimizer
    hiddenSizes: [64, 64], // MLP hidden layer widths (actor & critic)
    lr: 3e-4, // Adam learning rate
    // PPO / GAE
    gamma: 0.99, // discount factor
    lambda: 0.95, // GAE(λ) smoothing
    clip: 0.2, // PPO ratio clip epsilon
    epochs: 10, // optimization epochs per rollout
    minibatch: 64, // SGD minibatch size
    horizon: 2048, // transitions collected before each PPO update
    entCoef: 0.0, // entropy bonus coefficient (0 = off)
    vfCoef: 0.5, // value-loss weight
    initLogStd: -0.5, // initial per-action log-std (exploration scale)
    // Episode / control
    maxEpisodeSteps: 1000, // control steps before a timeout reset
    frameSkip: 4, // fixed physics steps per control step
    maxMotorSpeed: 8, // rad/s a |action|=1 commands to a motor
    fallHeight: 0.6, // root y below this => the creature has fallen
    maxTilt: 1.0, // |rootAngle| above this (rad) => toppled
    // Reward shaping
    wProgress: 60, // weight on forward progress (Δ rootX per control step)
    aliveBonus: 0.1, // per-step reward for staying up
    wEnergy: 0.02, // penalty weight on mean(action^2)
    wUpright: 0.3, // penalty weight on rootAngle^2
    // Observation
    speedScale: 0.1, // scales joint speeds (rad/s) into the obs vector
    // UI
    returnHistoryCap: 300, // cap on the episode-return graph history
  }),
});

export default CONFIG;
