/*
 * ui/panels/saveload.js — SAVE / LOAD SLOTS + FILE EXPORT / IMPORT.
 * =================================================================
 * localStorage slots (body-only or body+brain), the live slot list
 * (load / delete), plus .walkbrain.json export and import.
 *
 * IDs owned: slot-name, btn-save-creature, btn-save-bundle, slot-list,
 *            btn-export, file-import.
 * Calls into: storage.*, ctx.lanes.focusedLane(), ctx.addLane, ctx.setMsg,
 *             ctx.refresh.
 */

import { registerPanel } from '../registry.js';
import * as storage from '../../app/storage.js';

registerPanel({
  id: 'saveload',
  order: 30,
  region: 'train',
  mount(container, ctx) {
    const root = document.createElement('div');
    root.style.display = 'contents';
    root.innerHTML = `
      <div class="section">
        <div class="section-title">Save / Load</div>
        <input id="slot-name" type="text" placeholder="slot name…" />
        <div class="row">
          <button id="btn-save-creature" type="button">Save body</button>
          <button id="btn-save-bundle" type="button">Save + brain</button>
        </div>
        <div id="slot-list"></div>
        <div class="row">
          <button id="btn-export" type="button">Export file</button>
          <button type="button" class="file-btn">Import file
            <input id="file-import" type="file" accept=".json,application/json" />
          </button>
        </div>
      </div>
    `;
    container.appendChild(root);

    const slotName = document.getElementById('slot-name');
    const btnSaveCreature = document.getElementById('btn-save-creature');
    const btnSaveBundle = document.getElementById('btn-save-bundle');
    const slotList = document.getElementById('slot-list');
    const btnExport = document.getElementById('btn-export');
    const fileImport = document.getElementById('file-import');

    const focused = () => ctx.lanes.focusedLane();
    const slotNameOr = (fallback) => {
      const v = slotName && slotName.value.trim();
      return v || fallback || 'creature';
    };

    const saveCreature = () => {
      const lane = focused();
      if (!lane) return ctx.setMsg('No lane to save.', 'err');
      const name = slotNameOr(lane.name);
      storage.saveCreature(name, lane.creature);
      ctx.refresh();
      ctx.setMsg(`Saved body "${name}".`, 'ok');
    };

    const saveBundle = () => {
      const lane = focused();
      if (!lane) return ctx.setMsg('No lane to save.', 'err');
      const name = slotNameOr(lane.name);
      let brain = null;
      try {
        brain = lane.trainer.serialize();
      } catch (e) {
        return ctx.setMsg(`Could not serialize brain: ${e.message || e}`, 'err');
      }
      storage.saveBundle(name, lane.creature, brain);
      ctx.refresh();
      ctx.setMsg(`Saved body + brain "${name}".`, 'ok');
    };

    const exportFile = () => {
      const lane = focused();
      if (!lane) return ctx.setMsg('No lane to export.', 'err');
      let brain = null;
      try {
        brain = lane.trainer.serialize();
      } catch {
        brain = null; // export body-only if the brain can't be serialized
      }
      storage.exportBundle(lane.creature, brain);
      ctx.setMsg('Exported .walkbrain.json.', 'ok');
    };

    const importFile = () => {
      const file = fileImport && fileImport.files && fileImport.files[0];
      if (!file) return;
      storage
        .importFile(file)
        .then(({ creature, brain, name }) => {
          ctx.addLane(creature, { name, brain: brain || undefined });
        })
        .catch((e) => ctx.setMsg(`Import failed: ${e.message || e}`, 'err'))
        .finally(() => {
          if (fileImport) fileImport.value = '';
        });
    };

    const loadSlot = (key) => {
      const rec = storage.loadSlot(key);
      if (!rec) return ctx.setMsg('Slot is missing or corrupt.', 'err');
      ctx.addLane(rec.creature, {
        name: rec.name,
        brain: rec.kind === 'bundle' ? rec.brain : undefined,
      });
    };

    if (btnSaveCreature) btnSaveCreature.addEventListener('click', saveCreature);
    if (btnSaveBundle) btnSaveBundle.addEventListener('click', saveBundle);
    if (btnExport) btnExport.addEventListener('click', exportFile);
    if (fileImport) fileImport.addEventListener('change', importFile);

    // ---- Slot list (rebuilt on every ctx.refresh()) ----
    const renderSlots = () => {
      if (!slotList) return;
      slotList.innerHTML = '';
      const slots = storage.listSlots();
      if (slots.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'muted-line';
        empty.textContent = 'No saved slots yet.';
        slotList.appendChild(empty);
        return;
      }
      for (const s of slots) {
        const row = document.createElement('div');
        row.className = 'slot-row';

        const load = document.createElement('button');
        load.className = 'slot-name';
        load.type = 'button';
        load.textContent = `${s.kind === 'bundle' ? '🧠 ' : '🦿 '}${s.name}`;
        load.title = s.kind === 'bundle' ? 'Load body + brain' : 'Load body';
        load.addEventListener('click', () => loadSlot(s.key));

        const del = document.createElement('button');
        del.className = 'icon-btn';
        del.type = 'button';
        del.textContent = '✕';
        del.title = 'Delete slot';
        del.addEventListener('click', () => {
          storage.deleteSlot(s.key);
          ctx.refresh();
        });

        row.appendChild(load);
        row.appendChild(del);
        slotList.appendChild(row);
      }
    };

    ctx.onRefresh(renderSlots);
  },
});
