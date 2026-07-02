/*
 * ui/panels/mode.js — HEADER + MODE TOGGLE + MOBILE DRAWER.
 * ========================================================
 * Owns the top of the sidebar (title + blurb + Train/Editor switch) and the
 * mobile-only slide-up-drawer chrome (the ☰ button and the dimming scrim,
 * which live at <body> level because they're position:fixed page chrome).
 *
 * Installs the cross-cutting mode/drawer methods onto `ctx`:
 *   setMode(mode)   — flip app.mode and show #panel-train / #panel-editor,
 *                     matching the mode-button `active` state.
 *   openDrawer()/closeDrawer()/toggleDrawer() — slide the mobile sheet
 *                     (the `.open` class is inert on desktop, so this is safe
 *                     to call anywhere).
 *
 * IDs owned: btn-mode-train, btn-mode-editor (in sidebar);
 *            btn-menu, drawer-scrim (in <body>).
 * Reads (by id, at call time): panel-train, panel-editor, sidebar.
 */

import { registerPanel } from '../registry.js';

registerPanel({
  id: 'mode',
  order: 0,
  region: 'top',
  mount(container, ctx) {
    // Header + mode switch (top of the sidebar).
    const top = document.createElement('div');
    top.style.display = 'contents'; // no box; children lay out as sidebar kids
    top.innerHTML = `
      <h1>walk<span>-sim</span></h1>
      <p class="sub">Draw a creature, hinge &amp; limit its joints, then watch many of them learn to walk — each falls, resets to start, and tries again.</p>
      <div class="row">
        <button id="btn-mode-train" type="button" class="active">Train</button>
        <button id="btn-mode-editor" type="button">Editor</button>
      </div>
    `;
    container.appendChild(top);

    // Mobile chrome: ☰ toggle + dimming scrim, at <body> level (fixed-position
    // page chrome; hidden on desktop via the CSS in index.html).
    const btnMenu = document.createElement('button');
    btnMenu.id = 'btn-menu';
    btnMenu.type = 'button';
    btnMenu.setAttribute('aria-label', 'Toggle controls');
    btnMenu.textContent = '☰';

    const scrim = document.createElement('div');
    scrim.id = 'drawer-scrim';

    document.body.appendChild(btnMenu);
    document.body.appendChild(scrim);

    // --- Drawer methods (installed onto ctx) ---
    const sidebarEl = () => document.getElementById('sidebar');
    ctx.openDrawer = () => {
      sidebarEl().classList.add('open');
      scrim.classList.add('open');
      btnMenu.classList.add('active');
    };
    ctx.closeDrawer = () => {
      sidebarEl().classList.remove('open');
      scrim.classList.remove('open');
      btnMenu.classList.remove('active');
    };
    ctx.toggleDrawer = () => {
      if (sidebarEl().classList.contains('open')) ctx.closeDrawer();
      else ctx.openDrawer();
    };

    // --- Mode method (installed onto ctx) ---
    const btnTrain = document.getElementById('btn-mode-train');
    const btnEditor = document.getElementById('btn-mode-editor');
    ctx.setMode = (mode) => {
      ctx.app.mode = mode === 'editor' ? 'editor' : 'train';
      const editing = ctx.app.mode === 'editor';
      const pTrain = document.getElementById('panel-train');
      const pEditor = document.getElementById('panel-editor');
      if (pTrain) pTrain.style.display = editing ? 'none' : '';
      if (pEditor) pEditor.style.display = editing ? '' : 'none';
      if (btnTrain) btnTrain.classList.toggle('active', !editing);
      if (btnEditor) btnEditor.classList.toggle('active', editing);
    };

    // --- Wiring ---
    btnMenu.addEventListener('click', () => ctx.toggleDrawer());
    scrim.addEventListener('click', () => ctx.closeDrawer());
    if (btnTrain) btnTrain.addEventListener('click', () => ctx.setMode('train'));
    if (btnEditor) btnEditor.addEventListener('click', () => ctx.setMode('editor'));
  },
});
