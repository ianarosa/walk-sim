/*
 * ui/panels/graph.js — FOCUSED-LANE HUD + REWARD GRAPH.
 * =====================================================
 * The "Focused lane" section: a text stat card and a canvas that plots the
 * focused trainer's return history. Registers a per-frame hook (ctx.onFrame)
 * that the render loop drives once per rendered frame.
 *
 * IDs owned: hud, reward-graph.
 * Reads: ctx.lanes.focusedLane(), ctx.loop, CONFIG.theme.
 */

import { registerPanel } from '../registry.js';
import { CONFIG } from '../../config.js';

registerPanel({
  id: 'graph',
  order: 20,
  region: 'train',
  mount(container, ctx) {
    const root = document.createElement('div');
    root.style.display = 'contents';
    root.innerHTML = `
      <div class="section">
        <div class="section-title">Focused lane</div>
        <div class="card" id="hud">starting…</div>
        <canvas id="reward-graph"></canvas>
      </div>
    `;
    container.appendChild(root);

    const hud = document.getElementById('hud');
    const graph = document.getElementById('reward-graph');
    const graphCtx = graph ? graph.getContext('2d') : null;

    // Size the reward-graph backing store to CSS-size * DPR (crisp lines).
    let gw = 212;
    let gh = 66;
    if (graph) {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      gw = graph.clientWidth || 212;
      gh = graph.clientHeight || 66;
      graph.width = Math.round(gw * dpr);
      graph.height = Math.round(gh * dpr);
      if (graphCtx) graphCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const drawGraph = (lane) => {
      const g = graphCtx;
      if (!g) return;
      const W = gw;
      const H = gh;
      g.clearRect(0, 0, W, H);
      // Frosted panel backdrop.
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(0, 0, W, H);

      const hist = lane && lane.trainer && lane.trainer.returnHistory;
      if (!hist || hist.length < 2) {
        g.fillStyle = CONFIG.theme.labelMuted;
        g.font = '10px system-ui, sans-serif';
        g.textBaseline = 'middle';
        g.fillText('reward curve — collecting…', 8, H / 2);
        return;
      }
      let min = Infinity;
      let max = -Infinity;
      for (const v of hist) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min === max) {
        min -= 1;
        max += 1;
      }
      const pad = 6;
      const x = (i) => pad + (i / (hist.length - 1)) * (W - 2 * pad);
      const y = (v) => H - pad - ((v - min) / (max - min)) * (H - 2 * pad);

      // Zero baseline (if in range).
      if (min < 0 && max > 0) {
        g.strokeStyle = 'rgba(255,255,255,0.12)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(pad, y(0));
        g.lineTo(W - pad, y(0));
        g.stroke();
      }

      g.strokeStyle = CONFIG.theme.accent;
      g.lineWidth = 1.75;
      g.beginPath();
      for (let i = 0; i < hist.length; i++) {
        const px = x(i);
        const py = y(hist[i]);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();

      g.fillStyle = CONFIG.theme.labelMuted;
      g.font = '10px system-ui, sans-serif';
      g.textBaseline = 'top';
      g.fillText(`max ${max.toFixed(1)}`, 6, 4);
    };

    // Per-frame HUD text + graph (moved verbatim from the old updateHud()).
    const updateHud = () => {
      const lane = ctx.lanes.focusedLane();
      if (hud) {
        if (!lane) {
          hud.textContent = 'No lane focused.';
        } else {
          const t = lane.trainer;
          const ep = t.episode != null ? t.episode : 0;
          const best = t.bestDistance != null ? t.bestDistance : 0;
          const ret = t.lastReturn != null ? t.lastReturn : 0;
          const steps = t.stepCount != null ? t.stepCount : 0;
          hud.textContent =
            `${lane.name}\n` +
            `attempts ${ep}  ·  best ${Number(best).toFixed(2)} m\n` +
            `last return ${Number(ret).toFixed(1)}  ·  steps ${steps}` +
            `  ·  ${ctx.loop.paused ? 'PAUSED' : ctx.loop.speed + '×'}` +
            (t.exploit ? '  ·  exploit' : '');
        }
      }
      drawGraph(lane);
    };

    ctx.onFrame(updateHud);
  },
});
