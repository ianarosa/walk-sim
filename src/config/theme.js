/*
 * config/theme.js — glass-on-gradient presentation palette (UI + canvas).
 * ------------------------------------------------------------------
 * Palette + softness knobs so the physics view matches the frosted-glass UI.
 * This is a presentation-only tunable; the physics never reads it. The barrel
 * spreads this into CONFIG.
 */
export const themeConfig = Object.freeze({
  // --- Glass-on-gradient theme (UI + canvas) -----------------------------
  theme: Object.freeze({
    cellPanel: 'rgba(74,62,48,0.05)', // faint warm-neutral card behind each lane
    cellBorder: 'rgba(74,62,48,0.16)', // hairline sepia cell edge
    cellRadius: 18, // rounded corners for a lane cell, px
    focusBorder: 'rgba(143,211,255,0.85)', // focused-lane accent edge
    groundBand: 'rgba(74,62,48,0.12)', // matte studio-floor fill (warm sepia)
    groundEdge: 'rgba(74,62,48,0.40)', // sepia ground line (the calibrated floor)
    root: '#8fd3ff', // torso / root body
    foot: '#ffd98a', // feet
    limb: '#e7ecff', // other limbs
    outline: 'rgba(18,22,45,0.28)', // soft body stroke
    joint: 'rgba(255,255,255,0.9)', // subtle joint markers
    shadow: 'rgba(10,14,40,0.30)', // drop shadow under bodies
    label: '#f4f7ff', // cell label text
    labelMuted: 'rgba(244,247,255,0.72)',
    accent: '#8fd3ff', // primary accent (matches CSS)
    reset: '#ff9fb6', // fall->reset flash tint
    bodyRadiusFrac: 0.32, // corner-round fraction of a segment's short side
  }),
});
