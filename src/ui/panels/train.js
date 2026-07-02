/*
 * ui/panels/train.js — TRAIN CONTROLS + LANE LIST.
 * ================================================
 * The top of TRAIN mode: pause/resume all lanes, add a fresh biped lane, set
 * the speed (control-steps-per-frame), and the live list of lanes (focus /
 * exploit / reset / remove).
 *
 * IDs owned: btn-train-all, btn-add-lane, slider-speed, val-speed, lane-list.
 * Calls into: ctx.loop, ctx.lanes, ctx.addLane, ctx.setMsg, ctx.refresh.
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
            <label for="slider-speed">Speed (steps/frame)</label>
            <span class="val" id="val-speed">1×</span>
          </div>
          <input id="slider-speed" type="range" min="1" max="8" step="1" value="1" />
        </div>
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
    const laneList = document.getElementById('lane-list');

    const syncSpeed = () => {
      if (valSpeed) valSpeed.textContent = `${ctx.loop.speed}×`;
    };

    if (btnTrainAll) {
      btnTrainAll.addEventListener('click', () => {
        const paused = ctx.loop.togglePaused();
        btnTrainAll.textContent = paused ? 'Train all' : 'Pause all';
        btnTrainAll.classList.toggle('active', !paused);
      });
      // The default-biped starting lane is added by boot; the loop is running,
      // so the toggle label starts as "Pause all".
      btnTrainAll.textContent = 'Pause all';
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
