/*
 * ui/panels/train.js — TRAIN CONTROLS + LANE LIST.
 * ================================================
 * The top of TRAIN mode: pause/resume all lanes, add a fresh biped lane, set
 * the speed (control-steps-per-frame), and the live list of lanes (focus /
 * exploit / reset / remove).
 *
 * IDs owned: btn-train-all, select-preset, btn-add-lane, slider-speed,
 *            val-speed, slider-instances, val-instances, val-sps, lane-list.
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
// PRESETS drives the "add lane" picker — one entry per ready-made creature
// (biped, quadruped, worm…). Each has { id, name, emoji, make() } where make()
// returns a fresh, validated creature. Adding a preset is all we need here, so
// the old single-shape defaultBiped import is gone.
import { PRESETS } from '../../creature.js';

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
        </div>
        <!-- Preset picker: choose a ready-made creature shape, then "+ Add" it as
             a new training lane. The <select> is populated from PRESETS in JS so
             new presets appear automatically. -->
        <div class="row">
          <select id="select-preset" title="Creature preset to add"></select>
          <button id="btn-add-lane" type="button">+ Add</button>
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
    const selectPreset = document.getElementById('select-preset');
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

    // ---- Instances (total parallel training envs per lane, sharded) ----
    if (sliderInstances) {
      sliderInstances.min = '1';
      sliderInstances.max = String(CONFIG.RL.maxInstances); // up to 128
      sliderInstances.step = '1';
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
        const t = lane && lane.trainer;
        const sps = t ? t.stepsPerSec || 0 : 0;
        const inst = t ? t.instances : ctx.lanes.instances;
        // `workers` is the live shard count (undefined on any non-worker path).
        const w = t && t.workers != null ? t.workers : undefined;
        const wStr = w != null ? ` · ${w}w` : '';
        // Best net-forward distance ever reached — the clearest "how good is this
        // walker" signal. Guard for undefined/NaN so we simply omit it when absent.
        const best = t ? t.bestDistance : undefined;
        const bestStr =
          typeof best === 'number' && isFinite(best) ? ` · best ${best.toFixed(1)}m` : '';
        valSps.textContent = sps
          ? `training: ${Math.round(sps).toLocaleString()} steps/s · ${inst} envs${wStr}${bestStr}`
          : 'training: warming up…';
      });
    }

    // ---- Preset picker → "+ Add" a new lane ----
    // Fill the <select> from PRESETS (emoji + name label, id as the value). The
    // default selection is the FIRST preset, so a plain "+ Add" click adds it.
    // Resolve whichever preset the <select> currently points at.
    const currentPreset = () => {
      const id = selectPreset ? selectPreset.value : PRESETS[0].id;
      return PRESETS.find((p) => p.id === id) || PRESETS[0];
    };
    // The button names the chosen preset ("+ Add Worm") so it's obvious the
    // picker only chooses WHAT the Add button spawns — the dropdown alone does
    // nothing until you Add.
    const syncAddLabel = () => {
      if (btnAddLane) btnAddLane.textContent = `+ Add ${currentPreset().name}`;
    };
    if (selectPreset) {
      selectPreset.innerHTML = '';
      for (const preset of PRESETS) {
        const opt = document.createElement('option');
        opt.value = preset.id;
        opt.textContent = `${preset.emoji} ${preset.name}`;
        selectPreset.appendChild(opt);
      }
      selectPreset.addEventListener('change', syncAddLabel);
    }
    syncAddLabel();
    if (btnAddLane)
      btnAddLane.addEventListener('click', () => {
        // Build a fresh creature of the chosen preset, add it as a new lane, and
        // FOCUS it so the view immediately switches to the creature you picked
        // (addLane only auto-focuses when nothing is focused yet).
        const preset = currentPreset();
        const res = ctx.addLane(preset.make(), { name: preset.name });
        if (res && res.lane) ctx.lanes.focus(res.lane.id);
        ctx.refresh();
      });

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
      for (const [i, lane] of ctx.lanes.lanes.entries()) {
        const row = document.createElement('div');
        row.className = 'lane-row';
        if (lane.id === ctx.lanes.focusId) row.classList.add('focused');

        // Zero-padded TRIAL INDEX (01, 02, 03…) from the lane's position in
        // the list. Each lane is a parallel trial, so this numbering is
        // meaningful — it's a plate figure number, not decoration.
        const laneIdx = document.createElement('span');
        laneIdx.className = 'lane-idx';
        laneIdx.textContent = String(i + 1).padStart(2, '0');
        laneIdx.title = `Trial ${i + 1}`;

        const name = document.createElement('button');
        name.className = 'lane-name';
        name.type = 'button';
        name.textContent = lane.name;
        name.title = 'Focus this lane';
        name.addEventListener('click', () => {
          ctx.lanes.focus(lane.id);
          ctx.refresh();
        });

        // Point-in-time best-distance snapshot for THIS lane (the list is only
        // rebuilt on ctx.refresh(), so no per-frame wiring here — keep it cheap).
        const dist = document.createElement('span');
        dist.className = 'lane-dist';
        dist.style.cssText = 'opacity:.7;font-variant-numeric:tabular-nums';
        const best = lane.trainer && lane.trainer.bestDistance;
        dist.textContent =
          typeof best === 'number' && isFinite(best) ? `${best.toFixed(1)}m` : '';
        dist.title = 'Best net-forward distance reached';

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

        row.appendChild(laneIdx);
        row.appendChild(name);
        row.appendChild(dist);
        row.appendChild(exploit);
        row.appendChild(reset);
        row.appendChild(del);
        laneList.appendChild(row);
      }
    };

    ctx.onRefresh(renderLanes);
  },
});
