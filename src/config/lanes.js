/*
 * config/lanes.js — multi-lane training-grid layout tunables.
 * ------------------------------------------------------------------
 * Several creatures train side-by-side; each gets a viewport cell. Consumed by
 * src/app/lanes.js. The barrel spreads this into CONFIG.
 */
export const lanesConfig = Object.freeze({
  // --- Multi-lane training grid ------------------------------------------
  lanes: Object.freeze({
    fitMeters: 4.6, // vertical meters a cell tries to show (sets its PPM).
    groundFrac: 0.82, // ground line sits low in a cell (room to stand up).
    maxLanes: 12, // sanity cap so the grid stays legible.
  }),
});
