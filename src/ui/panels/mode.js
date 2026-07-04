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
    // ---- HEADER SIGNATURE: a Muybridge "gait filmstrip" nameplate -------
    // Six little study cells, each a stick-figure silhouette posed one phase
    // apart across ONE stride cycle — so left→right reads as a single walk,
    // exactly like a plate from Muybridge's 1887 "Animal Locomotion". CSS in
    // index.html steps an amber "active" highlight across the cells at a
    // walking cadence (and freezes it under prefers-reduced-motion).
    //
    // We generate the six SVGs from the gait math so the poses are honest
    // (and the code documents the stride) rather than hand-fudged. The figure
    // is drawn in a 24×24 box: a head, a torso, two swinging arms, and two
    // knee-bent legs in anti-phase. We sample the cycle at the MIDDLE of each
    // of the 6 frames (phase = (i + 0.5)/6 of a full turn) so no two frames
    // land on the same "legs together" pose.
    const gaitFilmstrip = () => {
      const FRAMES = 6;
      const HIP = { x: 12, y: 14 };      // pelvis pivot
      const SHOULDER_Y = 9;              // where the arms hang from
      const SWING = 4;                   // foot fore/aft travel (px)
      const cells = [];
      for (let i = 0; i < FRAMES; i++) {
        // Phase for THIS leg; the other leg + arms run in anti-phase.
        const s = Math.sin(((i + 0.5) / FRAMES) * Math.PI * 2);
        // Leg A leads by +swing, leg B trails by −swing; knees bend half-way.
        const aKnee = 12 + 1 * SWING * 0.5 * s, aFoot = 12 + SWING * s;
        const bKnee = 12 - 1 * SWING * 0.5 * s, bFoot = 12 - SWING * s;
        // Arms swing opposite their same-side leg (natural counter-rotation).
        const aHand = 12 - 3 * s;
        const bHand = 12 + 3 * s;
        const f = (n) => n.toFixed(1);
        cells.push(`
          <div class="gaitframe">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="5" r="2"/>
              <path d="M12 7 L12 ${HIP.y}"/>
              <path d="M12 ${SHOULDER_Y} L${f(aHand)} 12.5"/>
              <path d="M12 ${SHOULDER_Y} L${f(bHand)} 12.5"/>
              <path d="M12 ${HIP.y} L${f(aKnee)} 18 L${f(aFoot)} 22"/>
              <path d="M12 ${HIP.y} L${f(bKnee)} 18 L${f(bFoot)} 22"/>
            </svg>
          </div>`);
      }
      return `<div class="gaitstrip" aria-hidden="true">${cells.join('')}</div>`;
    };

    // Header + mode switch (top of the sidebar). The eyebrow names the study
    // ("ANIMAL LOCOMOTION"), a thin rule + a mono plate index sit beside it,
    // then the wordmark, blurb, and Train/Editor switch.
    const top = document.createElement('div');
    top.style.display = 'contents'; // no box; children lay out as sidebar kids
    top.innerHTML = `
      ${gaitFilmstrip()}
      <div class="eyebrow">
        <span>Animal Locomotion</span>
        <span class="rule"></span>
        <span class="plate-idx">Pl. 07</span>
      </div>
      <h1>walk<span>-sim</span></h1>
      <p class="sub">Draw a creature, limit its joints, and watch a fleet of them learn to walk — each falls, resets to the start line, and tries again.</p>
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
