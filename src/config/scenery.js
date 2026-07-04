/*
 * config/scenery.js — scenery & motion cues (presentation-only).
 * ------------------------------------------------------------------
 * A flat, art-directed PARALLAX LANDSCAPE (sun, hills, clouds, trees, bushes) +
 * ground distance markers + amber milestone flags, so you can SEE the walker
 * travelling. Physics never reads any of this; it is painted per-cell using that
 * cell's Camera (and, for parallax layers, a "virtual" camera whose x =
 * camera.focusX * factor). factor 0 = pinned to the screen, factor 1 = moves
 * fully with the world (the real camera). See src/scenery.js.
 *
 * Palette: a MUTED, limited, de-saturated landscape (sage/olive greens, dusty
 * blue-grey hills, soft off-white clouds, pale cream sun) that harmonizes with
 * the sidebar's warm umber study plate. The ONE bold accent is amber (#f2b134),
 * reserved for milestone flags. Screen-print / cut-paper, not candy pastel.
 * The barrel spreads this into CONFIG.
 */
export const sceneryConfig = Object.freeze({
  // --- Scenery & motion cues (presentation-only, see src/scenery.js) ------
  scenery: Object.freeze({
    // --- Feature 1: ground distance markers (retinted to the sepia palette) ---
    markerInterval: 1.0, // meters between MAJOR, labelled markers ("1m","2m"…)
    markerMinor: 0.5, // meters between minor (unlabelled) ticks
    markerTickH: 8, // px a minor tick drops below the ground line
    markerMajorTickH: 15, // px a major tick drops below the ground line
    markerMinorColor: 'rgba(74,62,48,0.18)', // subtle minor tick (warm sepia)
    markerMajorColor: 'rgba(74,62,48,0.34)', // darker major tick
    markerLabelColor: 'rgba(74,62,48,0.62)', // small "Nm" text (sepia)
    markerLabelFont: '10px system-ui, sans-serif',
    startLineColor: 'rgba(58,48,38,0.8)', // bold charcoal/sepia x=0 START line (not amber)
    startLineTickH: 26, // px the start line extends below the ground
    markerLabelMinPPM: 30, // hide labels+minor ticks when a cell is too zoomed out

    // --- Feature 2: parallax landscape (drawn back-to-front) ---------------
    // Each layer: parallax `factor` (smaller = further/slower drift), world
    // `spacing` (m) of its repeating field, and a per-tile `jitter` (m) so the
    // field looks natural but never flickers. VARIETY (height/width/form/tilt)
    // is hashed per tile so no two elements are identical — that kills the AI
    // clip-art look. Fills are FLAT (no soft radial blobs).

    // SUN: a single clean flat pale disc with one gentle radial halo (no rings).
    sun: Object.freeze({
      factor: 0.03, // near-pinned drift — furthest thing in the scene
      worldX: 0, // fixed world-x anchor (single sun, not a repeating field)
      topFrac: 0.14, // vertical center as a fraction down the cell (high sky)
      radius: 2.1, // sun disc radius, meters (× ppm)
      glowFrac: 1.7, // halo reach as a multiple of the disc radius
      color: 'rgba(247,240,220,0.72)', // pale warm cream disc, flat
      glowColor: 'rgba(247,240,220,0.20)', // gentle warm halo at the disc edge
      glowEdgeColor: 'rgba(247,240,220,0)', // fully transparent — halo's outer stop
    }),

    // HILLS: flat, overlapping TONAL BANDS (cut-paper depth). Back = paler +
    // higher; front = a touch darker + lower. Each band's ridge is sampled every
    // `step` meters with a hashed crest height in [minH,maxH] so it undulates.
    hills: Object.freeze({
      bands: [
        // Furthest: dusty blue-grey, tallest, slowest drift.
        Object.freeze({
          factor: 0.1,
          step: 6.0, // meters between ridge control points
          minH: 2.6, // ridge crest height range, meters
          maxH: 4.2,
          salt: 201, // hash salt (unique per band -> uncorrelated ridges)
          color: 'rgba(122,140,168,0.16)', // muted dusty blue-grey, low alpha
        }),
        // Middle: blue-grey-green, mid height.
        Object.freeze({
          factor: 0.16,
          step: 5.0,
          minH: 1.8,
          maxH: 3.0,
          salt: 202,
          color: 'rgba(120,146,138,0.2)', // muted teal-grey-green
        }),
        // Nearest hill band: muted green, lowest, a touch darker.
        Object.freeze({
          factor: 0.24,
          step: 4.0,
          minH: 1.1,
          maxH: 2.0,
          salt: 203,
          color: 'rgba(112,136,102,0.24)', // muted sage-green
        }),
      ],
    }),

    // CLOUDS: sparse, flat, elongated horizontal streaks (stratus), soft-faded
    // top+bottom so they feather into the sky — NO puffy lobed cumulus.
    clouds: Object.freeze({
      factor: 0.08, // furthest-feeling drift (sky)
      spacing: 11.0, // meters between candidate cloud slots
      jitter: 3.0, // ± meters stable jitter
      density: 0.5, // fraction of slots that actually get a cloud (sparse sky)
      topFrac: 0.1, // cloud band starts this fraction down the cell
      bandFrac: 0.26, // …and spans this fraction of the cell height
      minW: 2.6, // streak length range, meters (elongated)
      maxW: 5.6,
      minH: 0.34, // streak thickness range, meters (thin, flat)
      maxH: 0.62,
      color: 'rgba(248,246,240,0.7)', // soft warm-white core (flat, ~0.7)
      edgeColor: 'rgba(248,246,240,0)', // transparent top/bottom fade
    }),

    // TREES: two irregular depth ROWS of varied two-form silhouettes (rounded
    // broadleaf + narrow conifer), flat fills, slight per-tree tilt, sparse.
    trees: Object.freeze({
      minH: 1.4, // base tree height range, meters (× row.scale)
      maxH: 2.7,
      maxTilt: 0.1, // ± radians of slight per-tree lean (~±5.7°)
      coniferFrac: 0.4, // fraction of trees drawn as the tall narrow form
      // BACK row: paler, smaller, sparser, slower — sits behind.
      back: Object.freeze({
        factor: 0.4,
        spacing: 4.4, // meters between candidate slots
        jitter: 1.4, // ± meters stable jitter
        density: 0.6, // fraction of slots with a tree
        scale: 0.78, // height multiplier (smaller, further)
        canopyColor: 'rgba(126,150,112,0.4)', // pale muted sage
        trunkColor: 'rgba(120,98,78,0.34)', // muted warm brown
      }),
      // FRONT row: deeper, larger, still sparse — sweeps by faster.
      front: Object.freeze({
        factor: 0.56,
        spacing: 5.2,
        jitter: 1.6,
        density: 0.5,
        scale: 1.0,
        canopyColor: 'rgba(96,124,84,0.5)', // deeper muted olive-green
        trunkColor: 'rgba(96,74,56,0.46)', // deeper muted brown
      }),
    }),

    // BUSHES: near, low flat irregular clumps, sparse and muted.
    bushes: Object.freeze({
      factor: 0.78, // near layer, sweeps by fastest (short of the creature)
      spacing: 2.4, // meters between candidate slots
      jitter: 0.7, // ± meters stable jitter
      density: 0.55, // fraction of slots with a bush (scattered)
      minW: 0.7, // clump width range, meters
      maxW: 1.5,
      minH: 0.3, // clump height range, meters
      maxH: 0.55,
      color: 'rgba(104,128,88,0.52)', // muted olive, close = a touch more opaque
    }),

    // --- Feature 1b: milestone flags (the ONE amber accent, every N meters) ---
    // Pennant flags pinned to fixed world x every `interval` meters, drawn with
    // the REAL camera (factor 1) so their poles stand exactly on the ground line.
    // Sizes are in meters (× ppm at draw time) so they scale with the creature.
    // The amber flag echoes the UI accent — the single bold color in the scene.
    milestones: Object.freeze({
      interval: 10, // meters between milestone flags (10m, 20m, 30m…)
      poleH: 1.6, // pole height above the ground line, meters
      flagW: 0.7, // flag triangle width (from pole outward), meters
      flagH: 0.5, // flag triangle height, meters
      poleColor: 'rgba(74,62,48,0.5)', // thin sepia pole
      flagColor: '#f2b134', // amber pennant — the ONE bold accent (matches UI)
      labelColor: 'rgba(74,62,48,0.7)', // "10m" text, bolder than minor labels
      labelFont: '600 11px system-ui, sans-serif', // slightly bold + larger
    }),
  }),
});
