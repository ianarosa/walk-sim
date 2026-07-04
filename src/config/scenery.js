/*
 * config/scenery.js — scenery & motion cues (presentation-only).
 * ------------------------------------------------------------------
 * A MUYBRIDGE-STYLE calibrated motion field: a scrolling meter GRID + distance
 * markers + amber milestone flags, so you can SEE the walker travelling across a
 * measured studio wall. Physics never reads any of this; it is painted per-cell
 * using that cell's Camera. For the grid/markers we use the REAL camera (world-
 * locked, parallax factor 1) so everything scrolls past as painted-on marks. See
 * src/scenery.js. The barrel spreads this into CONFIG.
 *
 * Palette: muted warm sepia/greige (cohesive with the sidebar's umber study
 * plate). The ONE bold accent is amber (#f2b134) — reserved for milestone flags.
 */
export const sceneryConfig = Object.freeze({
  // --- Scenery & motion cues (presentation-only, see src/scenery.js) ------
  scenery: Object.freeze({
    // --- Feature 1: ground distance markers (retinted to the sepia field) ---
    markerInterval: 1.0, // meters between MAJOR, labelled markers ("1m","2m"…)
    markerMinor: 0.5, // meters between minor (unlabelled) ticks
    markerTickH: 8, // px a minor tick drops below the ground line
    markerMajorTickH: 15, // px a major tick drops below the ground line
    markerMinorColor: 'rgba(74,62,48,0.18)', // subtle minor tick (warm sepia)
    markerMajorColor: 'rgba(74,62,48,0.34)', // darker major tick
    markerLabelColor: 'rgba(74,62,48,0.62)', // small "Nm" text (sepia, reads on field)
    markerLabelFont: '10px system-ui, sans-serif',
    startLineColor: 'rgba(58,48,38,0.8)', // bold charcoal/sepia x=0 START line (not amber)
    startLineTickH: 26, // px the start line extends below the ground
    markerLabelMinPPM: 30, // hide labels+minor ticks when a cell is too zoomed out

    // --- Feature 2: the calibrated backdrop (Muybridge measurement wall) ---
    // A scrolling vertical METER grid + faint horizontal height references +
    // an optional flat far-horizon band. All world-locked (factor 1). Drive
    // every spacing/color/width from here. See drawParallax in src/scenery.js.
    grid: Object.freeze({
      minorEvery: 1, // meters between faint vertical gridlines
      majorEvery: 5, // every Nth meter is a BOLD numbered-wall gridline
      minorColor: 'rgba(74,62,48,0.08)', // faint 1m gridline (warm sepia)
      majorColor: 'rgba(74,62,48,0.16)', // darker 5m gridline
      minorWidth: 1, // px, minor vertical line
      majorWidth: 1, // px, major vertical line
      wallColor: 'rgba(74,62,48,0.07)', // faint horizontal wall reference lines
      wallWidth: 1, // px, horizontal line
      wallHeights: [1, 2, 3], // whole-meter HEIGHTS above the ground for wall lines
      horizonColor: 'rgba(74,62,48,0.05)', // flat far-horizon band (null to disable)
      horizonFrac: 0.6, // band center as a fraction down the cell (low depth hint)
      horizonH: 2, // px, band thickness
    }),

    // --- Feature 1b: milestone flags (the ONE amber accent, every N meters) ---
    // Pennant flags pinned to fixed world x every `interval` meters, drawn with
    // the REAL camera (factor 1) so their poles stand exactly on the ground line.
    // Sizes are in meters (× ppm at draw time) so they scale with the creature.
    // The amber flag echoes the UI accent — the single bold color in the field.
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
