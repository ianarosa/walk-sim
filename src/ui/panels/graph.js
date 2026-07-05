/*
 * ui/panels/graph.js — FOCUSED-LANE HUD + REWARD GRAPH.
 * =====================================================
 * The "Focused lane" section: a grid of labeled stat tiles and a canvas that
 * plots the focused trainer's return history. Registers a per-frame hook
 * (ctx.onFrame) that the render loop drives once per rendered frame.
 *
 * The frame hook is deliberately CHEAP on its common path: the graph only
 * redraws when the focused lane or its history actually grew, and each stat
 * tile only touches the DOM when its rendered text changed. Everything the
 * loop drives per frame is a couple of comparisons unless a value moved.
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
        <div class="card" id="hud"></div>
        <canvas id="reward-graph"></canvas>
      </div>
    `;
    container.appendChild(root);

    const hud = document.getElementById('hud');
    const graph = document.getElementById('reward-graph');
    const graphCtx = graph ? graph.getContext('2d') : null;

    // --- Stat-tile grid --------------------------------------------------
    // Re-shape #hud (mono text blob in index.html) into a compact 3-col grid.
    // No global CSS to lean on here, so the plate identity — condensed
    // uppercase labels + mono tabular values — is applied inline, reusing the
    // same --font-*/--muted/--text/--accent tokens the rest of the sidebar does.
    if (hud) {
      hud.style.display = 'grid';
      hud.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
      hud.style.gap = '9px 10px';
      hud.style.whiteSpace = 'normal'; // override #hud's pre-line rule
    }

    // Full-width lane name header (spans all columns), then the value tiles.
    let nameEl = null;
    const tiles = {}; // key -> value <span>, updated only when text changes.

    if (hud) {
      nameEl = document.createElement('div');
      nameEl.style.gridColumn = '1 / -1';
      nameEl.style.fontFamily = 'var(--font-condensed)';
      nameEl.style.fontSize = '12px';
      nameEl.style.letterSpacing = '0.02em';
      nameEl.style.color = 'var(--text)';
      nameEl.style.whiteSpace = 'nowrap';
      nameEl.style.overflow = 'hidden';
      nameEl.style.textOverflow = 'ellipsis';
      hud.appendChild(nameEl);

      const makeTile = (key, label, accent) => {
        const tile = document.createElement('div');
        tile.style.display = 'flex';
        tile.style.flexDirection = 'column';
        tile.style.gap = '1px';
        tile.style.minWidth = '0';

        const lab = document.createElement('div');
        lab.textContent = label;
        lab.style.fontFamily = 'var(--font-condensed)';
        lab.style.fontSize = '9px';
        lab.style.fontWeight = '600';
        lab.style.letterSpacing = '0.09em';
        lab.style.textTransform = 'uppercase';
        lab.style.color = 'var(--muted)';

        const val = document.createElement('div');
        val.style.fontFamily = 'var(--font-mono)';
        val.style.fontSize = '12.5px';
        val.style.fontVariantNumeric = 'tabular-nums';
        val.style.color = accent ? 'var(--accent)' : 'var(--text)';
        val.style.whiteSpace = 'nowrap';
        val.style.overflow = 'hidden';
        val.style.textOverflow = 'ellipsis';
        val.textContent = '—';

        tile.appendChild(lab);
        tile.appendChild(val);
        hud.appendChild(tile);
        tiles[key] = val;
      };

      makeTile('attempts', 'Attempts', false);
      makeTile('best', 'Best (m)', true); // the ONE amber value
      makeTile('ret', 'Last Return', false);
      makeTile('steps', 'Steps', false);
      makeTile('mode', 'Mode', false);
    }

    // Cache of last-rendered tile text so the frame hook can bail per value.
    const shown = { name: null, attempts: null, best: null, ret: null, steps: null, mode: null };
    // Set a tile only when its text actually changed (avoids DOM churn).
    const setVal = (key, text) => {
      if (shown[key] === text) return;
      shown[key] = text;
      const el = key === 'name' ? nameEl : tiles[key];
      if (el) el.textContent = text;
    };

    // --- Reward graph ----------------------------------------------------
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

    // --- Per-frame hook (throttled) -------------------------------------
    // Common path: the graph is only redrawn when the focused lane changed or
    // its returnHistory grew (return history only appends once per rollout —
    // seconds apart), and each stat tile is only rewritten when its text moved.
    let lastLaneId = undefined;  // focused lane's id at last draw (null = none)
    let lastHistLen = -1;        // returnHistory.length at last draw

    const updateHud = () => {
      const lane = ctx.lanes.focusedLane();

      // Stat tiles (setVal bails per-tile when unchanged).
      if (hud) {
        if (!lane) {
          setVal('name', 'No lane focused');
          setVal('attempts', '—');
          setVal('best', '—');
          setVal('ret', '—');
          setVal('steps', '—');
          setVal('mode', ctx.loop.paused ? 'PAUSED' : ctx.loop.speed + '×');
        } else {
          const t = lane.trainer;
          const ep = t.episode != null ? t.episode : 0;
          const best = t.bestDistance != null ? t.bestDistance : 0;
          const ret = t.lastReturn != null ? t.lastReturn : 0;
          const steps = t.stepCount != null ? t.stepCount : 0;
          const mode = ctx.loop.paused
            ? 'PAUSED'
            : (t.exploit ? 'EXPLOIT' : ctx.loop.speed + '×');
          setVal('name', lane.name);
          setVal('attempts', String(ep));
          setVal('best', Number(best).toFixed(2));
          setVal('ret', Number(ret).toFixed(1));
          setVal('steps', String(steps));
          setVal('mode', mode);
        }
      }

      // Reward graph — skip the redraw unless the lane or its history moved.
      const laneId = lane ? lane.id : null;
      const histLen = (lane && lane.trainer && lane.trainer.returnHistory)
        ? lane.trainer.returnHistory.length
        : 0;
      if (laneId !== lastLaneId || histLen !== lastHistLen) {
        lastLaneId = laneId;
        lastHistLen = histLen;
        drawGraph(lane);
      }
    };

    ctx.onFrame(updateHud);
  },
});
