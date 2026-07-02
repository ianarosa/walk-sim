/*
 * config/scenery.js — scenery & motion cues (presentation-only).
 * ------------------------------------------------------------------
 * Distance markers on the ground + a layered PARALLAX backdrop so you can SEE
 * the walker actually travelling. Physics never reads any of this; it is
 * painted per-cell using that cell's Camera (and, for parallax layers, a
 * "virtual" camera whose x = camera.focusX * factor). factor 0 = pinned to the
 * screen, factor 1 = moves fully with the world (the real camera). See
 * src/scenery.js. The barrel spreads this into CONFIG.
 */
export const sceneryConfig = Object.freeze({
  // --- Scenery & motion cues (presentation-only, see src/scenery.js) ------
  scenery: Object.freeze({
    // --- Feature 1: ground distance markers ---
    markerInterval: 1.0, // meters between MAJOR, labelled markers ("1m","2m"…)
    markerMinor: 0.5, // meters between minor (unlabelled) ticks
    markerTickH: 8, // px a minor tick drops below the ground line
    markerMajorTickH: 15, // px a major tick drops below the ground line
    markerMinorColor: 'rgba(255,255,255,0.16)', // subtle minor tick
    markerMajorColor: 'rgba(255,255,255,0.34)', // brighter major tick
    markerLabelColor: 'rgba(30,40,80,0.55)', // small "Nm" text (reads on pastel)
    markerLabelFont: '10px system-ui, sans-serif',
    startLineColor: 'rgba(120,180,255,0.85)', // the distinct x=0 START line
    startLineTickH: 26, // px the start line extends below the ground
    markerLabelMinPPM: 30, // hide labels+minor ticks when a cell is too zoomed out

    // --- Feature 2: parallax layers (drawn back-to-front) ---
    // Each layer: parallax `factor`, world `spacing` (m) of its repeating field,
    // and a per-tile `jitter` (m) so the field looks natural but never flickers.
    hills: Object.freeze({
      factor: 0.15, // far, drifts slowly
      spacing: 8.0, // meters between hill centers (before jitter)
      jitter: 2.4, // ± meters of stable horizontal jitter per hill
      minH: 1.6, // shortest hill, meters
      maxH: 3.4, // tallest hill, meters
      widthFrac: 1.7, // hill half-width as a multiple of its height
      colorFar: 'rgba(120,140,200,0.12)', // back row (paler, higher)
      colorNear: 'rgba(120,140,200,0.18)', // front row (a touch stronger)
    }),
    clouds: Object.freeze({
      factor: 0.08, // furthest-feeling drift (sky)
      spacing: 9.5, // meters between clouds
      jitter: 3.2, // ± meters stable jitter
      topFrac: 0.08, // cloud band starts this fraction down the cell
      bandFrac: 0.34, // …and spans this fraction of the cell height
      minR: 0.9, // cloud lobe radius range, meters
      maxR: 1.7,
      color: 'rgba(255,255,255,0.55)', // soft white blobs
    }),
    trees: Object.freeze({
      factor: 0.5, // mid layer, sweeps by noticeably
      spacing: 3.6, // meters between trees
      jitter: 1.1, // ± meters stable jitter
      minH: 1.4, // trunk-to-canopy-top height range, meters
      maxH: 2.6,
      canopyColor: 'rgba(120,200,150,0.34)', // soft green canopy
      trunkColor: 'rgba(110,84,66,0.34)', // muted brown trunk
    }),
    bushes: Object.freeze({
      factor: 0.8, // near layer, sweeps by fastest (short of the creature)
      spacing: 1.7, // meters between bushes
      jitter: 0.55, // ± meters stable jitter
      minH: 0.32, // clump height range, meters
      maxH: 0.6,
      color: 'rgba(120,200,150,0.5)', // stronger green, close = more opaque
    }),
  }),
});
