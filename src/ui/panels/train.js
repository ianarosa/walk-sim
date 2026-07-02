/*
 * ui/panels/train.js — TRAIN CONTROLS + LANE LIST.
 * ================================================
 * The top of TRAIN mode: pause/resume all lanes, add a fresh biped lane, set
 * the speed (control-steps-per-frame), and the live list of lanes (focus /
 * exploit / reset / remove).
 *
 * IDs owned: btn-train-all, btn-add-lane, slider-speed, val-speed,
 *            slider-instances, val-instances, val-sps, lane-list.
 * Calls into: ctx.loop, ctx.lanes, ctx.addLane, ctx.setMsg, ctx.refresh.
 *
 * Phase 2: training runs in a background Worker PER LANE (see app/worker-lane.js),
 * so the render loop no longer scales training with "speed". The speed slider is
 * repurposed to the PREVIEW playback rate (control-steps per frame for the live
 * preview only); a new instances slider sets how many parallel envs each worker
 * trains; and a steps/sec readout shows the focused lane's training throughput.
 */

import { registerPanel } from '../registry.js';
import { CONFIG } from '../../config.js';
import { defaultBiped } from '../../creature.js';

registerPanel({
  id: 'train',
  order: 10,
  region: 'train',
  mount(container, ctx) {
    const root = document.createElement('div');
    root.style.display = 'contents';
    root.innerHTML = `
      <div class="section" style="border-top:none; padding-top:0;">
        <div class="row">
          <button id="btn-train-all" type="button">Pause all</button>
          <button id="btn-add-lane" type="button">+ Add biped</button>
        </div>
        <div class="field">
          <div class="label-row">
            <label for="slider-instances">Instances (parallel envs)</label>
            <span class="val" id="val-instances">8</span>
          </div>
          <input id="slider-instances" type="range" min="1" max="16" step="1" value="8" />
        </div>
        <div class="field">
          <div class="label-row">
            <label for="slider-speed">Preview speed (×)</label>
            <span class="val" id="val-speed">1×</span>
          </div>
          <input id="slider-speed" type="range" min="1" max="8" step="1" value="1" />
        </div>
        <div class="muted-line" id="val-sps">training: warming up…</div>
      </div>

      <div class="section">
        <div class="section-title">Lanes</div>
        <div id="lane-list"></div>
      </div>
    `;
    container.appendChild(root);

    const btnTrainAll = document.getElementById('btn-train-all');
    const btnAddLane = document.getElementById('btn-add-lane');
    const slider = document.getElementById('slider-speed');
    const valSpeed = document.getElementById('val-speed');
    const sliderInstances = document.getElementById('slider-instances');
    const valInstances = document.getElementById('val-instances');
    const valSps = document.getElementById('val-sps');
    const laneList = document.getElementById('lane-list');

    const syncSpeed = () => {
      if (valSpeed) valSpeed.textContent = `${ctx.loop.speed}×`;
    };

    if (btnTrainAll) {
      btnTrainAll.addEventListener('click', () => {
        const paused = ctx.loop.togglePaused();
        // In worker mode training runs off-thread; pausing the render loop only
        // freezes the PREVIEW, so also stop/resume each worker's training so
        // "Pause all" genuinely halts learning (and stats stop climbing).
        ctx.lanes.setRunningAll(!paused);
        btnTrainAll.textContent = paused ? 'Train all' : 'Pause all';
        btnTrainAll.classList.toggle('active', !paused);
      });
      // The default-biped starting lane is added by boot; the loop is running,
      // so the toggle label starts as "Pause all".
      btnTrainAll.textContent = 'Pause all';
    }

    // ---- Instances (parallel training envs per lane's worker) ----
    if (sliderInstances) {
      sliderInstances.value = String(ctx.lanes.instances);
      if (valInstances) valInstances.textContent = String(ctx.lanes.instances);
      sliderInstances.addEventListener('input', () => {
        const v = ctx.lanes.setInstancesAll(Number(sliderInstances.value));
        sliderInstances.value = String(v);
        if (valInstances) valInstances.textContent = String(v);
      });
    }

    // ---- Training throughput readout (focused lane), refreshed per frame ----
    if (valSps) {
      ctx.onFrame(() => {
        const lane = ctx.lanes.focusedLane();
        const sps = lane && lane.trainer ? lane.trainer.stepsPerSec || 0 : 0;
        const inst = lane && lane.trainer ? lane.trainer.instances : ctx.lanes.instances;
        valSps.textContent = sps
          ? `training: ${Math.round(sps).toLocaleString()} steps/s · ${inst} envs`
          : 'training: warming up…';
      });
    }

    if (btnAddLane)
      btnAddLane.addEventListener('click', () => ctx.addLane(defaultBiped()));

    if (slider) {
      slider.min = '1';
      slider.max = String(CONFIG.loop.maxSpeed);
      slider.step = '1';
      slider.value = String(ctx.loop.speed);
      slider.addEventListener('input', () => {
        const v = ctx.loop.setSpeed(Number(slider.value));
        slider.value = String(v);
        syncSpeed();
      });
      syncSpeed();
    }

    // ---- Lane list (rebuilt on every ctx.refresh()) ----
    const renderLanes = () => {
      if (!laneList) return;
      laneList.innerHTML = '';
      if (ctx.lanes.lanes.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'muted-line';
        empty.textContent = 'No lanes. Add one, or spawn from the editor.';
        laneList.appendChild(empty);
        return;
      }
      for (const lane of ctx.lanes.lanes) {
        const row = document.createElement('div');
        row.className = 'lane-row';
        if (lane.id === ctx.lanes.focusId) row.classList.add('focused');

        const name = document.createElement('button');
        name.className = 'lane-name';
        name.type = 'button';
        name.textContent = lane.name;
        name.title = 'Focus this lane';
        name.addEventListener('click', () => {
          ctx.lanes.focus(lane.id);
          ctx.refresh();
        });

        const exploit = document.createElement('label');
        exploit.className = 'lane-exploit';
        exploit.title = 'Exploit: show the best gait (no exploration)';
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = !!lane.trainer.exploit;
        chk.addEventListener('change', () => ctx.lanes.setExploit(lane.id, chk.checked));
        exploit.appendChild(chk);
        exploit.appendChild(document.createTextNode('E'));

        const reset = document.createElement('button');
        reset.className = 'icon-btn';
        reset.type = 'button';
        reset.textContent = '⟲';
        reset.title = 'Reset this lane (fresh brain)';
        reset.addEventListener('click', () => {
          ctx.lanes.resetLane(lane.id);
          ctx.setMsg(`Reset "${lane.name}".`);
        });

        const del = document.createElement('button');
        del.className = 'icon-btn';
        del.type = 'button';
        del.textContent = '✕';
        del.title = 'Remove this lane';
        del.addEventListener('click', () => {
          ctx.lanes.removeLane(lane.id);
          ctx.refresh();
        });

        row.appendChild(name);
        row.appendChild(exploit);
        row.appendChild(reset);
        row.appendChild(del);
        laneList.appendChild(row);
      }
    };

    ctx.onRefresh(renderLanes);
  },
});
