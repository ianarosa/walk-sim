/*
 * rl/nn.js — a tiny dense MLP with MANUAL backprop, plus an Adam optimizer
 *            and a Welford running-mean/std normalizer. No autodiff library.
 * ========================================================================
 * This module is the numeric bedrock of the RL layer. It is deliberately
 * dependency-free and readable: everything is plain Float64Array math so the
 * gradients are auditable by eye. The policy (actor) and value (critic)
 * networks are both built out of the `MLP` class here.
 *
 * Layout convention for a layer with `nIn` inputs and `nOut` outputs:
 *   - W is a row-major Float64Array of length nOut*nIn. Row o (length nIn)
 *     holds the weights feeding output neuron o.  z_o = Σ_i W[o*nIn+i]*a_i.
 *   - b is a Float64Array of length nOut (the biases).
 * Every parameter tensor has a parallel gradient tensor of the same shape;
 * backward() ACCUMULATES into those grads (so many samples can be summed
 * before a single optimizer step), and the optimizer zeroes them after use.
 *
 * Randomness: the ONLY source of nondeterminism is Math.random(), funnelled
 * through gaussian() below, so a seeded/overridden Math.random makes runs
 * reproducible.
 */

// --- Random helpers ------------------------------------------------------

/**
 * gaussian() — one standard-normal sample via Box–Muller. All network init
 * and policy exploration noise flow through here, so Math.random is the sole
 * randomness source in the whole RL stack.
 */
export function gaussian() {
  // u1 in (0,1] to keep log() finite.
  let u1 = 0;
  while (u1 <= 0) u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// --- Activations ---------------------------------------------------------
// Each activation is a {f, dfFromA} pair: dfFromA computes the derivative
// from the POST-activation value `a` where cheap (tanh), else from pre-act.

const ACTS = {
  tanh: {
    f: (z) => Math.tanh(z),
    // d/dz tanh = 1 - tanh(z)^2 = 1 - a^2
    dFromA: (a) => 1 - a * a,
  },
  relu: {
    f: (z) => (z > 0 ? z : 0),
    // derivative depends on the pre-activation sign; a>0 <=> z>0 for relu.
    dFromA: (a) => (a > 0 ? 1 : 0),
  },
  linear: {
    f: (z) => z,
    dFromA: () => 1,
  },
};

// --- MLP -----------------------------------------------------------------

/**
 * MLP — fully-connected feed-forward net.
 *   sizes:  [nIn, h1, h2, ..., nOut]  (>= 2 entries)
 *   hidden: 'tanh' | 'relu'           (all hidden layers share this)
 *   output is always LINEAR (the policy squashes / the critic uses raw V).
 *
 * forward(x) caches per-layer pre-activations and activations so a following
 * backward(dOut) can run without recomputation. It is single-sample: call
 * forward then backward before the next forward if you need that sample's
 * gradient (the RL trainer loops sample-by-sample within a minibatch).
 */
export class MLP {
  constructor(sizes, hidden = 'tanh') {
    if (!Array.isArray(sizes) || sizes.length < 2)
      throw new Error('MLP: sizes must be [nIn, ..., nOut] with >=2 entries');
    this.sizes = sizes.slice();
    this.hidden = hidden in ACTS ? hidden : 'tanh';
    this.layers = [];

    for (let l = 0; l < sizes.length - 1; l++) {
      const nIn = sizes[l];
      const nOut = sizes[l + 1];
      const isLast = l === sizes.length - 2;
      // Xavier-ish init: std = gain/sqrt(nIn). tanh gain ~1; small init keeps
      // early logits near zero so the policy starts close to "do nothing".
      const std = (isLast ? 0.01 : 1.0) / Math.sqrt(nIn);
      const W = new Float64Array(nOut * nIn);
      for (let k = 0; k < W.length; k++) W[k] = gaussian() * std;
      this.layers.push({
        nIn,
        nOut,
        act: isLast ? 'linear' : this.hidden,
        W,
        b: new Float64Array(nOut), // zero bias init
        gW: new Float64Array(nOut * nIn), // grad accumulator for W
        gB: new Float64Array(nOut), // grad accumulator for b
        // Caches, filled by forward():
        aIn: null, // input activation to this layer (Float64Array)
        aOut: null, // output activation of this layer
      });
    }
  }

  /** forward(x) -> Float64Array output; caches activations for backward(). */
  forward(x) {
    let a = x;
    for (let l = 0; l < this.layers.length; l++) {
      const L = this.layers[l];
      L.aIn = a;
      const out = new Float64Array(L.nOut);
      const act = ACTS[L.act];
      for (let o = 0; o < L.nOut; o++) {
        let z = L.b[o];
        const base = o * L.nIn;
        for (let i = 0; i < L.nIn; i++) z += L.W[base + i] * a[i];
        out[o] = act.f(z);
      }
      L.aOut = out;
      a = out;
    }
    return a;
  }

  /**
   * backward(dOut) — reverse-mode gradient of a scalar loss w.r.t. the cached
   * forward pass. `dOut` is dLoss/dOutput (length nOut of the last layer).
   * ACCUMULATES into each layer's gW/gB and returns dLoss/dInput so callers
   * can chain (unused by the actor/critic, but part of the contract).
   */
  backward(dOut) {
    let dA = dOut;
    for (let l = this.layers.length - 1; l >= 0; l--) {
      const L = this.layers[l];
      const act = ACTS[L.act];
      // dz = dA * f'(z), using the cached post-activation aOut.
      const dz = new Float64Array(L.nOut);
      for (let o = 0; o < L.nOut; o++) dz[o] = dA[o] * act.dFromA(L.aOut[o]);
      // Accumulate parameter grads and build dInput for the previous layer.
      const dIn = new Float64Array(L.nIn);
      for (let o = 0; o < L.nOut; o++) {
        const base = o * L.nIn;
        const g = dz[o];
        L.gB[o] += g;
        for (let i = 0; i < L.nIn; i++) {
          L.gW[base + i] += g * L.aIn[i];
          dIn[i] += g * L.W[base + i];
        }
      }
      dA = dIn;
    }
    return dA;
  }

  /**
   * parameters() — flat list of {w, g} slots (value tensor + its grad tensor)
   * in a STABLE order, for an Adam optimizer to consume. Order is preserved
   * across calls so the optimizer's moment estimates stay aligned.
   */
  parameters() {
    const out = [];
    for (const L of this.layers) {
      out.push({ w: L.W, g: L.gW });
      out.push({ w: L.b, g: L.gB });
    }
    return out;
  }

  /** applyGrads(adam) — one optimizer step over this net's parameters. */
  applyGrads(adam) {
    adam.update(this.parameters());
  }

  serialize() {
    return {
      sizes: this.sizes.slice(),
      hidden: this.hidden,
      layers: this.layers.map((L) => ({
        W: Array.from(L.W),
        b: Array.from(L.b),
      })),
    };
  }

  load(obj) {
    // Trust the shape matches (the Trainer checks obs/act sizes up front).
    for (let l = 0; l < this.layers.length; l++) {
      this.layers[l].W = Float64Array.from(obj.layers[l].W);
      this.layers[l].b = Float64Array.from(obj.layers[l].b);
      this.layers[l].gW = new Float64Array(this.layers[l].W.length);
      this.layers[l].gB = new Float64Array(this.layers[l].b.length);
    }
    return this;
  }
}

// --- Adam optimizer ------------------------------------------------------

/**
 * Adam — the standard adaptive-moment optimizer (Kingma & Ba, 2015):
 *   m_t = β1 m_{t-1} + (1-β1) g
 *   v_t = β2 v_{t-1} + (1-β2) g^2
 *   m̂ = m_t/(1-β1^t),  v̂ = v_t/(1-β2^t)
 *   θ  ← θ - lr * m̂ / (√v̂ + ε)
 * It keeps per-parameter moment tensors keyed by the ORDER of the {w,g}
 * slots handed to update(); allocate lazily on first sight of each slot.
 * After stepping it ZEROES the grad tensors so accumulation can restart.
 */
export class Adam {
  constructor(lr = 3e-4, beta1 = 0.9, beta2 = 0.999, eps = 1e-8) {
    this.lr = lr;
    this.b1 = beta1;
    this.b2 = beta2;
    this.eps = eps;
    this.t = 0;
    this._m = null; // Float64Array[] parallel to the param slots
    this._v = null;
  }

  update(params) {
    if (this._m === null) {
      this._m = params.map((p) => new Float64Array(p.w.length));
      this._v = params.map((p) => new Float64Array(p.w.length));
    }
    this.t += 1;
    const bc1 = 1 - Math.pow(this.b1, this.t);
    const bc2 = 1 - Math.pow(this.b2, this.t);
    for (let s = 0; s < params.length; s++) {
      const { w, g } = params[s];
      const m = this._m[s];
      const v = this._v[s];
      for (let i = 0; i < w.length; i++) {
        let gi = g[i];
        // NaN/Inf guard: a poisoned gradient would corrupt the moments
        // permanently, so drop it rather than propagate.
        if (!Number.isFinite(gi)) gi = 0;
        m[i] = this.b1 * m[i] + (1 - this.b1) * gi;
        v[i] = this.b2 * v[i] + (1 - this.b2) * gi * gi;
        const mHat = m[i] / bc1;
        const vHat = v[i] / bc2;
        w[i] -= (this.lr * mHat) / (Math.sqrt(vHat) + this.eps);
        g[i] = 0; // reset accumulator for the next batch
      }
    }
  }
}

// --- Welford running normalizer -----------------------------------------

/**
 * Normalizer — online mean/variance over observation vectors (Welford's
 * algorithm), used to whiten observations before they hit the networks.
 * PPO is far more stable on standardized inputs, and because the statistics
 * drift as the agent explores, an online estimator (rather than a fixed
 * pre-pass) is the right tool. Persisted with the brain so a restored policy
 * sees inputs on the same scale it was trained on.
 */
export class Normalizer {
  constructor(dim) {
    this.dim = dim;
    this.mean = new Float64Array(dim);
    this.M2 = new Float64Array(dim); // sum of squared deviations
    this.count = 1e-4; // tiny epsilon so the first update is well-defined
  }

  /** Fold one raw observation into the running statistics. */
  update(x) {
    this.count += 1;
    const n = this.count;
    for (let i = 0; i < this.dim; i++) {
      const delta = x[i] - this.mean[i];
      this.mean[i] += delta / n;
      this.M2[i] += delta * (x[i] - this.mean[i]);
    }
  }

  /** normalize(x) -> whitened copy, clipped to +/-5 to tame outliers. */
  normalize(x) {
    const out = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      const variance = this.M2[i] / this.count;
      const std = Math.sqrt(variance) || 1;
      let z = (x[i] - this.mean[i]) / (std < 1e-2 ? 1e-2 : std);
      if (z > 5) z = 5;
      else if (z < -5) z = -5;
      out[i] = z;
    }
    return out;
  }

  serialize() {
    return {
      dim: this.dim,
      mean: Array.from(this.mean),
      M2: Array.from(this.M2),
      count: this.count,
    };
  }

  load(obj) {
    this.dim = obj.dim;
    this.mean = Float64Array.from(obj.mean);
    this.M2 = Float64Array.from(obj.M2);
    this.count = obj.count;
    return this;
  }
}
