/*
 * config/render.js — body/render color palette (dark theme).
 * ------------------------------------------------------------------
 * The colors the physics view paints bodies/ground/joints with. Consumed by
 * src/render.js. The barrel spreads this into CONFIG.
 */
export const renderConfig = Object.freeze({
  // --- Colors (dark theme) ----------------------------------------------
  colors: Object.freeze({
    background: '#05070c',
    root: '#7cc4ff', // torso / root body
    foot: '#ffd166', // bodies flagged isFoot
    limb: '#c7cdd6', // every other dynamic body
    ground: '#1b2230',
    groundLine: '#2c3340', // top edge accent
    joint: '#ff6b8a', // little pivot dots
    outline: 'rgba(0,0,0,0.35)', // body stroke
  }),
});
