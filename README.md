# DatamoshLive

Real-time datamosh effect via WebCodecs (VP8 / VP9 / H.264). Runs a VideoEncoder/VideoDecoder pair and deliberately mismatches reference frames to produce motion smearing, pixel drift, and packet-loss artifacts — all in the browser, on any live source.

**Requires** Chrome / Edge 94+ over HTTPS or localhost.

**Credits:** Over-delta datamoshing technique by [Amagi](https://codepen.io/fand/pen/Vwojwqm). Inspired by [Hydra Datamosh](https://github.com/emptyflash/hydra-datamosh) (Emptyflash) and [Hydra Synth](https://github.com/hydra-synth/hydra) input handling patterns. API design, keyframe-drop datamosh method and h264 implementation by [geikha](https://github.com/geikha). General implementation, refactoring and documentation was done using Claude Code.

---

## Install / build

```sh
npm install
npm run build   # → dist/datamoshlive.js (IIFE) + dist/datamoshlive.esm.js
npm run dev     # watch mode
npm run serve   # static server on :3003
```

## Quick start

```html
<script src="dist/datamoshlive.js"></script>
<script>
  const dm = new DatamoshLive({ renderWidth: 640, renderHeight: 480 });
  document.body.appendChild(dm.canvas);
  await dm.initCamera();   // starts automatically
</script>
```

```js
// ESM
import DatamoshLive from './dist/datamoshlive.esm.js';
```

---

## Constructor

```js
const dm = new DatamoshLive(opts)
```

| Option | Default | Description |
|---|---|---|
| `renderWidth` | `640` | Encoder/decoder resolution (processing size) |
| `renderHeight` | `480` | Encoder/decoder resolution (processing size) |
| `displayWidth` | `renderWidth` | Output canvas width (can differ from render) |
| `displayHeight` | `renderHeight` | Output canvas height |
| `canvas` | `createElement('canvas')` | Bring your own canvas element |
| `params` | `{}` | Initial parameter overrides (see Parameters) |

`dm.canvas` is the raw `HTMLCanvasElement`. Style and position it yourself.

---

## Source methods

### `await dm.initCamera(opts?)`
Opens the webcam and starts the loop. Returns the internal `<video>` element.
- `opts.constraints` — MediaStreamConstraints (default: ideal render size)
- `opts.autoStart` — set `false` to not call `start()` automatically

### `await dm.initVideo(source, opts?)`
Load a video file URL or an existing `<video>` element.
- `source` — URL string or `HTMLVideoElement`
- `opts.autoStart` — default `true`

### `dm.initCanvas(canvas, opts?)`
Use any `HTMLCanvasElement` as a live source (e.g. another generative sketch).

---

## Loop control

### `dm.start()`
Begin the capture/encode/decode loop.

### `dm.stop()`
Pause the loop. Call `start()` to resume.

---

## Effect methods

### `dm.smear()`
**One-shot smear.** Forces a keyframe, drops it, then auto-recovers after ~30 delta frames (~1 second at 30 fps). The decoder's reference stays stale during that window — incoming delta frames paint old content into new positions.

### `dm.sync()`
**Force clean sync.** Forces a keyframe and delivers it to the decoder. Cancels any pending smear or recovery. Use this to snap back to a clean image at any time.

### `dm.corrupt()`
**One-shot packet-loss artifact.** Zeros out a random contiguous region of the next delta frame's encoded payload before it reaches the decoder. Produces block corruption, color drift, or freeze artifacts depending on which bytes are hit. Auto-recovers after ~30 delta frames.

---

## Parameters

All parameters support **live functions** — set a parameter to a function and it will be called each frame. Static values, functions, or mixed.

```js
// Static
dm.speed = 5;

// Live — called each frame
dm.speed = () => Math.sin(Date.now() / 1000) * 3 + 2;

// Booleans from truthy/falsy, numbers from expressions
dm.autoSmear = () => Math.random() < 0.1;
dm.smearRate = () => (Date.now() % 1000) / 1000;
```

Functions receive **automatic type coercion** and **bounds clamping**:
- Booleans: `!!value`
- Numbers: rounded (if integer param), clamped to min/max
- Invalid/undefined: falls back to default
- Non-finite (Infinity, NaN): uses default

Set directly as properties or via `setParam(name, value)` / `setParams({...})`.

### Effect

| Property | Type | Default | Description |
|---|---|---|---|
| `dm.speed` | `number` | `2` | Times each delta frame is decoded. Higher = stronger motion smear accumulation. _Integer._ |
| `dm.enabled` | `boolean` | `true` | `false` bypasses the codec entirely and draws the source directly |

### Hold — freeze frame

| Property | Type | Default | Description |
|---|---|---|---|
| `dm.hold` | `boolean` | `false` | `true` drops all incoming chunks — the last decoded frame stays frozen on the canvas. On release (`false`), incoming keyframes are skipped and the pipeline waits for the first delta frame to run over the frozen image, then auto-recovers after ~30 deltas |

### Smear — keyframe dropping

| Property | Type | Default | Description |
|---|---|---|---|
| `dm.autoSmear` | `boolean` | `false` | Continuously drop keyframes at random, creating persistent smear |
| `dm.smearRate` | `number` | `0.5` | Probability (0–1) a keyframe is dropped per keyframe event when `autoSmear` is on |

Keyframes are forced every 60 frames when `autoSmear` is on, so there are frames to drop.

### Corrupt — payload corruption

| Property | Type | Default | Description |
|---|---|---|---|
| `dm.autoCorrupt` | `boolean` | `false` | Continuously corrupt delta frames at random |
| `dm.corruptRate` | `number` | `0.5` | Probability (0–1) a delta frame is corrupted per frame when `autoCorrupt` is on |
| `dm.corruptAmount` | `number` | `0.3` | Fraction (0–1) of the frame's byte payload to zero out per corruption event |

The first ~10 bytes of each frame are preserved to reduce hard decoder crashes. The decoder auto-reinitialises if it enters an error state.

### Codec

| Property | Type | Default | Description |
|---|---|---|---|
| `dm.bitrate` | `number` | `1_000_000` | Encoder bitrate in bits/s. Lower = more compression artifacts |
| `dm.codec` | `string` | `'vp8'` | `'vp8'`, `'vp9'`, or `'h264'` |

`'h264'` automatically selects the appropriate AVC level (3.0–4.1) based on your render resolution. H.264 support is browser and platform-dependent — Chrome/Edge may support it, but it's not universally available. You can also pass any raw WebCodecs codec string directly.

Changing `bitrate` or `codec` resets the encoder/decoder pair.

### Display

| Property | Type | Default | Description |
|---|---|---|---|
| `dm.fit` | `string` | `'stretch'` | How the source is scaled into the render canvas: `'stretch'` (distort to fill), `'fill'` (crop to fill), `'fit'` (letterbox to fit) |
| `dm.fps` | `number` | `30` | Frame capture rate limit. `0` = unlimited |

---

## Size methods

### `dm.setRenderSize(width, height)`
Change the encoder/decoder resolution. Resets the codec pipeline. H.264 AVC level recalculates automatically.

Shorthand: `dm.width = 800; dm.height = 600;`

### `dm.setDisplaySize(width, height)`
Resize the output canvas. Does not reset the codec — decoded frames are just drawn at a different scale.

### `dm.setFPS(fps)`
Set the capture frame rate limit. `0` = run as fast as `requestAnimationFrame` allows.

---

## Display helpers

### `dm.show()`
Appends `dm.canvas` to `document.body`.

### `dm.hide()`
Removes `dm.canvas` from the DOM.

### `dm.destroy()`
Stops the loop, removes the canvas, and closes the encoder/decoder.

---

## Livecode examples

```js
// Camera with oscillating smear
const dm = new DatamoshLive({ renderWidth: 320, renderHeight: 240 });
document.body.appendChild(dm.canvas);
await dm.initCamera();

// Speed follows sine wave
dm.speed = () => Math.sin(Date.now() / 1000) * 8 + 8;

// Pulsing smear rate
dm.autoSmear = true;
dm.smearRate = () => Math.abs(Math.sin(Date.now() / 2000));

// Beat-synced corruption (on odd seconds)
dm.autoCorrupt = () => (Math.floor(Date.now() / 1000) % 2) === 1;
dm.corruptAmount = () => Math.random() * 0.5;

// Time-based hold (freeze for 500ms every 2s)
dm.hold = () => (Date.now() % 2000) < 500;

// Complex time-dependent effect
const wave = () => {
  const t = Date.now() / 5000;
  return Math.sin(t) * 0.3 + 0.5;
};
dm.smearRate = wave;
dm.corruptRate = wave;

// Snap back clean
dm.sync();

// Change resolution on the fly
dm.width = 640;
dm.height = 480;

// Use H.264 (platform-dependent)
dm.codec = 'h264';
```

---

## How it works

VP8/VP9/H.264 delta frames are encoded relative to a reference frame (the last keyframe the decoder received). When that keyframe is dropped before reaching the decoder, the decoder's reference stays stale. Every delta frame after that is decoded against the wrong reference — motion vectors move old pixels into new positions, producing the characteristic datamosh smear.

`smear()` forces this mismatch deliberately, then schedules a recovery keyframe after ~30 frames so the image cleans up without manual intervention.

`corrupt()` operates differently: it zeroes out a region of a delta frame's encoded bitstream before decode. The decoder conceals the loss using surrounding block data, producing block corruption and color artifacts. Also auto-recovers after ~30 deltas.

`hold` freezes the canvas by dropping all incoming encoded chunks. On release, the pipeline skips keyframes and waits for the first delta to composite over the frozen image — creating a brief smear-on-freeze effect — before auto-recovering.
