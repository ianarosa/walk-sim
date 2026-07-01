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

  // --- Scenery & motion cues (presentation-only, see src/scenery.js) ------
  // Distance markers on the ground + a layered PARALLAX backdrop so you can
  // SEE the walker actually travelling. Physics never reads any of this; it is
  // painted per-cell using that cell's Camera (and, for parallax layers, a
  // "virtual" camera whose x = camera.focusX * factor). factor 0 = pinned to
  // the screen, factor 1 = moves fully with the world (the real camera).
  scenery: Object.freeze({
    // --- Feature 1: ground distance markers ---
    markerInterval: 1.0, // meters between MAJOR, labelled markers ("1m","2m"…)
    markerMinor: 0.5, // meters between minor (unlabelled) ticks
    markerTickH: 8, // px a minor tick drops below the ground line
    markerMajorTickH: 15, // px a major tick drops below the ground line
    markerMinorColor: 'rgba(255,255,255,0.16)', // subtle minor tick
    markerMajorColor: 'rgba(255,255,255,0.34)', // brighter major tick
    markerLabelColor: 'rgba(30,40,80,0.55)', // small "Nm" text (reads on pastel)
    markerLabelFont: '10px system-ui, sans-serif',
    startLineColor: 'rgba(120,180,255,0.85)', // the distinct x=0 START line
    startLineTickH: 26, // px the start line extends below the ground
    markerLabelMinPPM: 30, // hide labels+minor ticks when a cell is too zoomed out

    // --- Feature 2: parallax layers (drawn back-to-front) ---
    // Each layer: parallax `factor`, world `spacing` (m) of its repeating field,
    // and a per-tile `jitter` (m) so the field looks natural but never flickers.
    hills: Object.freeze({
      factor: 0.15, // far, drifts slowly
      spacing: 8.0, // meters between hill centers (before jitter)
      jitter: 2.4, // ± meters of stable horizontal jitter per hill
      minH: 1.6, // shortest hill, meters
      maxH: 3.4, // tallest hill, meters
      widthFrac: 1.7, // hill half-width as a multiple of its height
      colorFar: 'rgba(120,140,200,0.12)', // back row (paler, higher)
      colorNear: 'rgba(120,140,200,0.18)', // front row (a touch stronger)
    }),
    clouds: Object.freeze({
      factor: 0.08, // furthest-feeling drift (sky)
      spacing: 9.5, // meters between clouds
      jitter: 3.2, // ± meters stable jitter
      topFrac: 0.08, // cloud band starts this fraction down the cell
      bandFrac: 0.34, // …and spans this fraction of the cell height
      minR: 0.9, // cloud lobe radius range, meters
      maxR: 1.7,
      color: 'rgba(255,255,255,0.55)', // soft white blobs
    }),
    trees: Object.freeze({
      factor: 0.5, // mid layer, sweeps by noticeably
      spacing: 3.6, // meters between trees
      jitter: 1.1, // ± meters stable jitter
      minH: 1.4, // trunk-to-canopy-top height range, meters
      maxH: 2.6,
      canopyColor: 'rgba(120,200,150,0.34)', // soft green canopy
      trunkColor: 'rgba(110,84,66,0.34)', // muted brown trunk
    }),
    bushes: Object.freeze({
      factor: 0.8, // near layer, sweeps by fastest (short of the creature)
      spacing: 1.7, // meters between bushes
      jitter: 0.55, // ± meters stable jitter
      minH: 0.32, // clump height range, meters
      maxH: 0.6,
      color: 'rgba(120,200,150,0.5)', // stronger green, close = more opaque
    }),
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
