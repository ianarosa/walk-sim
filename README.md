# walk-sim

An "AI learns to walk" sandbox. **This slice has no learning yet** — it is a
default biped ragdoll built from a plain creature-definition object, dropped
onto a ground plane, simulated with [planck.js](https://piqnt.com/planck.js/)
(a JS port of Box2D), rendered on a camera-followed fullscreen canvas, with a
floating dark sidebar for controls.

## Run it

No build step, no `npm install`. Either:

- **Open `index.html` directly** in a modern browser, or
- **Serve statically** (recommended, avoids any file:// module quirks):

  ```sh
  python3 -m http.server 8000
  # then visit http://localhost:8000/
  ```

## Controls (the floating sidebar)

- **Reset** — rebuild the biped from scratch.
- **Pause / Play** — freeze / resume the physics.
- **Flail joints** — each physics step, drive every motor with a random
  target speed so the joints visibly move within their limits.
- **Sim speed** — physics steps per frame (1–8); fast-forwards the sim.

## Layout

```
sim/
  index.html          fullscreen canvas + floating sidebar
  vendor/planck.min.js  planck.js v1.0.0 (Box2D), loaded as a plain script
  src/
    config.js         CONFIG constants (PPM, gravity, colors, RL placeholder)
    creature.js       shared creature schema + defaultBiped()
    physics/
      build.js        Creature -> live planck world (bodies, joints, contacts)
      sim.js          Sim class: the generic surface the RL layer will consume
    render.js         draw ground + bodies + joint pivots
    ui/
      camera.js       smooth follow camera + world<->screen helpers
      loop.js         fixed-timestep loop (accumulator, pause, speed)
      controls.js     wire the sidebar to the sim & loop
    main.js           entry point
```

Physics is in **meters, y-up** (gravity `(0,-10)`); the canvas is **pixels,
y-down**. The y-flip lives only in the render/camera transform.
