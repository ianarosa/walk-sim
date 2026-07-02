/*
 * config/editor.js — creature-editor screen<->meters tunables.
 * ------------------------------------------------------------------
 * The editor draws creatures in its OWN fixed screen<->meters mapping,
 * independent of the training camera (which pans/zooms). See src/ui/editor.js
 * for the exact origin/PPM convention. The barrel spreads this into CONFIG.
 */
export const editorConfig = Object.freeze({
  // --- Creature editor ---------------------------------------------------
  editor: Object.freeze({
    ppm: 90, // editor pixels-per-meter. 90 => a 1m torso is 90px on screen.
    groundFrac: 0.72, // fraction of canvas height where world y=0 is drawn.
    grid: 0.1, // snap-to-grid increment, meters.
    minSize: 0.06, // smallest allowed body dimension, meters (guards specks).
    handleRadius: 0.7, // meters; radius at which joint limit handles/arc sit.
    hitPad: 8, // px slack when hit-testing handles/anchors with the pointer.
    defaultTorque: 80, // N*m default for a freshly-created joint's motor.
    maxTorque: 300, // upper bound of the torque slider.
  }),
});
