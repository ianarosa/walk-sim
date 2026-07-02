/*
 * config/rl.js — reinforcement-learning hyperparameters.
 * ------------------------------------------------------------------
 * Consumed by src/rl/* (Trainer, policy, value, env). These are layered UNDER
 * any explicit config passed to `new Trainer(sim, config)` and OVER the
 * RL_DEFAULTS baked into agent.js, so overriding here is the norm. The barrel
 * spreads this into CONFIG.
 */
export const rlConfig = Object.freeze({
  // --- Reinforcement-learning hyperparameters ----------------------------
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
    maxMotorSpeed: 5, // rad/s a |action|=1 commands to a motor (was 8: too violent)
    fallHeight: 0.6, // root y below this => the creature has fallen
    maxTilt: 1.0, // |rootAngle| above this (rad) => toppled
    // Reward shaping — balance-first locomotion (see rl/env.js for the formula).
    aliveBonus: 1.0, // per-step reward for staying up (dominant BASE term)
    wVel: 1.0, // weight on capped forward velocity min(avgVx, vTarget)
    vTarget: 1.4, // m/s cap on the forward-velocity reward (don't over-sprint)
    uprightThresh: 0.5, // rad; forward reward only counts while |rootAngle| < this
    targetHeight: 1.25, // desired torso height (m); penalize deviation (no crouch cheat)
    wHeight: 3.0, // penalty weight on (rootY - targetHeight)^2
    wUpright: 0.3, // penalty weight on rootAngle^2
    wEnergy: 0.05, // penalty weight on mean(action^2)
    wSmooth: 0.05, // penalty weight on mean(Δaction^2) — reduces jitter/flailing
    // Observation
    speedScale: 0.1, // scales joint speeds (rad/s) into the obs vector
    // UI
    returnHistoryCap: 300, // cap on the episode-return graph history
  }),
});
