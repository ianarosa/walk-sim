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
    initLogStd: -1.0, // initial per-action log-std (was -0.5). Tighter exploration
    // keeps the GREEDY/deterministic gait (what Exploit + live preview render)
    // close to the sampled behavior, so the mean policy reliably walks forward
    // instead of lagging in a stuck/backward basin.
    // Episode / control
    // 0 = NO step-timeout: an episode ends ONLY on a fall/tilt (the user asked
    // to remove the movement timeout so a good walker can run indefinitely).
    // Set this > 0 to re-enable a hard control-step cap per episode (reversible).
    maxEpisodeSteps: 0, // 0 = no timeout; episodes end on fall/tilt only
    frameSkip: 4, // fixed physics steps per control step
    maxMotorSpeed: 5, // rad/s a |action|=1 commands to a motor (was 8: too violent)
    fallHeight: 0.6, // root y below this => the creature has fallen
    maxTilt: 1.0, // |rootAngle| above this (rad) => toppled
    // Reward shaping — THREE PILLARS: FASTEST + FURTHEST + SMOOTHEST.
    // (see rl/env.js for the exact formula). Balance terms are deliberately
    // MINIMAL — just enough to stop faceplanting/flailing and to keep the
    // deterministic gait stable — so the three pillars dominate the gradient.
    // vTarget is gone: faster is always better. Verified in a headless PPO
    // harness (real planck) that the GREEDY gait is faster + further + smoother
    // than the old capped reward across seeds, with no NaNs and no flailing.
    aliveBonus: 1.0, // minimal per-step "stay up" support — a FLOOR, not the goal.
    //   forward reward (~wVel*vx + wProgress*dx ≈ 3.2 at 1.8 m/s) still dominates
    //   it; tuned up from 0.4 so the deterministic gait reliably stays upright.
    // FASTEST: reward forward speed with NO cap (was min(avgVx, vTarget)).
    wVel: 1.0, // weight on uncapped SIGNED forward speed (avgVx, upright-gated)
    // FURTHEST: reward net forward progress directly (ΔrootX this control step).
    wProgress: 12.0, // weight on SIGNED forward ΔX per step (upright-gated)
    uprightThresh: 0.5, // rad; speed/progress only count while |rootAngle| < this (gate)
    // SMOOTHEST: first-class anti-jitter penalties.
    wSmooth: 2.0, // penalty weight on mean(Δaction^2) — kills frame-to-frame jitter (was 0.05)
    wJerk: 0.6, // penalty weight on mean((Δjointspeed·speedScale)^2) — kills motor twitching
    // Minimal balance/effort support (prerequisite, not objective).
    targetHeight: 1.25, // desired torso height (m); penalize deviation (no crouch cheat)
    wHeight: 2.0, // penalty weight on (rootY - targetHeight)^2 (was 3.0)
    wUpright: 0.35, // penalty weight on rootAngle^2
    wEnergy: 0.05, // penalty weight on mean(action^2) — tiny motor-effort tax
    // Observation
    speedScale: 0.1, // scales joint speeds (rad/s) into the obs vector
    // UI
    returnHistoryCap: 300, // cap on the episode-return graph history
    // Multi-worker sharded training (see app/worker-lane.js + rl/brain-merge.js).
    // A lane fans its instances across several Web Workers (one per CPU core, up
    // to a small cap); every mergeMs the workers' brains are weight-AVERAGED
    // (local-SGD / EASGD style) so they keep converging on ONE shared brain.
    maxInstances: 128, // UI cap on total parallel training envs per lane
    mergeMs: 1000, // weight-average cadence across a lane's worker shards (ms)
  }),
});
