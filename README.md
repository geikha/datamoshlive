# DatamoshLive

Real-time datamosh effects in the browser using WebCodecs. Feed it a camera or video, trigger drops and corruptions, watch frames smear.

![DatamoshLive demo](demo/dml-demo-img.jpg)

**Requires** Chrome / Edge 94+ over HTTPS or localhost.

**Credits:** Over-delta technique by [Amagi](https://codepen.io/fand/pen/Vwojwqm). Inspired by [Hydra Datamosh](https://github.com/emptyflash/hydra-datamosh) (Emptyflash) and [Hydra Synth](https://github.com/hydra-synth/hydra). API design and H.264 implementation by [geikha](https://github.com/geikha). General implementation and documentation done using Claude Code.

---

## Install

```sh
npm install datamoshlive
npm run build   # → dist/datamoshlive.js + dist/datamoshlive.esm.js
```

Or use the CDN:

```html
<script src="https://unpkg.com/datamoshlive@latest/dist/datamoshlive.js"></script>
```

---

## Getting started

```js
const dm = new DatamoshLive({ width: 640, height: 480 });
dm.mount();  // append to document.body (or pass a custom parent element)
await dm.initCam();

// Click to smear
dm.canvas.addEventListener('click', () => dm.drop());
```

That's it. `dm.canvas` is a plain `<canvas>` — customize size and positioning as needed.

---

## Common patterns

**Drop on click:**
```js
dm.canvas.addEventListener('click', () => dm.drop());
```

**Continuous probabilistic dropping:**
```js
dm.dropRate = 0.15;   // 15% chance per frame; 0 = off
```

**Freeze and smear on hold:**
```js
dm.canvas.addEventListener('mousedown', () => dm.hold = true);
dm.canvas.addEventListener('mouseup',   () => dm.hold = false);
```

**Persistent datamosh (no auto-recovery):**
```js
dm.recover = false;
dm.drop();            // stays glitched until dm.sync()
```

**Parameters as live functions (called every frame):**
```js
let mouseX = 0;
document.addEventListener('mousemove', (e) => {
  mouseX = e.clientX / window.innerWidth;
});
dm.speed = () => Math.floor(mouseX * 4) + 1;  // 1–5 based on mouse X
```

**Capture and replay a moment:**
```js
dm.sample(30);                       // capture the next 30 frames
setTimeout(() => dm.inject(), 500);  // replay them half a second later
// dm.sampleLoop = true;                // keep looping until stopInject()
```

---

## API

### Constructor

```js
const dm = new DatamoshLive(opts)
```

| Option | Default | Description |
|---|---|---|
| `width` | `640` | Encoder/decoder resolution |
| `height` | `480` | Encoder/decoder resolution |
| `canvasWidth` | `width` | Output canvas size (can differ from render resolution) |
| `canvasHeight` | `height` | Output canvas size |
| `canvas` | auto | Provide an existing `<canvas>` element |
| `params` | `{}` | Initial parameter overrides |

---

### Sources

All source methods are async. The loop starts automatically unless you pass `autoStart: false`.

#### `await dm.initCam(selector?, opts?)`
Open a webcam. `selector` is a camera index (number, default `0`) or a label string.

#### `await dm.initVideo(source, opts?)`
Load a video file. `source` is a URL string or an existing `<video>` element. Loops automatically.

#### `await dm.initCanvas(canvas, opts?)`
Use any `<canvas>` as a live source (e.g. a generative sketch).

---

### Loop

#### `dm.start()`
Start or restart the capture/encode/decode loop. Safe to call while already running.

#### `dm.stop()`
Pause the loop.

---

### Effect calls

#### `dm.drop()`
Drop the next encoded frame. The decoder keeps its old reference and decodes subsequent deltas against stale content — producing motion smear. Auto-recovers after `recoverAfter` frames if `recover` is enabled.

#### `dm.corrupt()`
Zero out a random region of the next encoded frame's bitstream before decode. Produces block corruption and color drift rather than smear. Also auto-recovers.

#### `dm.sync()`
Force a clean keyframe and deliver it to the decoder immediately. Cancels any pending drop or recovery. Use this to snap back to a clean image at any time.

---

### Parameters

Set directly as properties or via `setParam(name, value)` / `setParams({...})`.

All parameters accept **live functions** — set a function and it will be called each frame, with automatic type coercion and bounds clamping:

```js
dm.speed = 4;                                             // static
dm.speed = () => Math.sin(Date.now() / 500) * 3 + 4;    // live
```

#### Effect

| Parameter | Type | Default | Description |
|---|---|---|---|
| `dm.speed` | integer ≥1 | `1` | Times each delta frame is decoded. Higher = stronger smear accumulation |
| `dm.enabled` | boolean | `true` | `false` bypasses the codec entirely and draws source frames directly |
| `dm.hold` | boolean | `false` | Freeze the canvas — drops all incoming frames. On release, smears briefly before recovering |

#### Drop

| Parameter | Type | Default | Description |
|---|---|---|---|
| `dm.dropRate` | 0–1 | `0` | Per-frame drop probability. `0` = off |

#### Corrupt

| Parameter | Type | Default | Description |
|---|---|---|---|
| `dm.corruptRate` | 0–1 | `0` | Per-frame corruption probability. `0` = off |
| `dm.corruptAmount` | 0–1 | `0.3` | Fraction of frame bytes zeroed per corruption event |

#### Recovery

| Parameter | Type | Default | Description |
|---|---|---|---|
| `dm.recover` | boolean | `true` | Auto-recover after drops and corruptions |
| `dm.recoverAfter` | integer | `fps \|\| 30` | Frames to wait before forcing a clean recovery keyframe |

#### Codec / display

| Parameter | Type | Default | Description |
|---|---|---|---|
| `dm.bitrate` | number | `1000000` | Encoder bitrate in bits/s. Lower = more compression artifacts |
| `dm.codec` | string | `'vp8'` | `'vp8'`, `'vp9'`, `'h264'`, or `'av1'`. H.264 and AV1 availability is browser/platform-dependent |
| `dm.fit` | string | `'fill'` | Canvas scaling: `'fill'` (crop to fill), `'fit'` (letterbox), `'stretch'` (distort) |
| `dm.fps` | number | `30` | Frame rate cap. `0` = unlimited |

Codec strings are automatically resolved to the appropriate level for your render resolution. You can also pass a raw WebCodecs codec string directly.

Changing `bitrate` or `codec` resets the encoder/decoder pair.

---

### Sample / inject

Capture a buffer of encoded frames and replay it.

#### `dm.sample(n?)`
Capture the next `n` frames into the buffer (default: `sampleFrames`). Captures post-effect output — artifacts are baked in.

#### `dm.inject()`
Replay the buffer instead of encoding the live feed. Plays once then stops unless `sampleLoop` is `true`. Also triggers recovery when `recover` is enabled.

#### `dm.stopInject()`
Stop injection and resume live encoding.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `dm.sampleFrames` | integer | `1` | Default frame count for `sample()` |
| `dm.sampleLoop` | boolean | `false` | `true` = loop buffer indefinitely, `false` = play once then stop |

---

### Size

#### `dm.setResolution(width, height)`
Change the encoder/decoder resolution. Resets the codec pipeline.

Also: `dm.width = 800; dm.height = 600;`

#### `dm.resizeCanvas(width, height)`
Resize the output canvas. Does not reset the codec.

---

### Display

Remove `dm.canvas` from the DOM.

#### `dm.show()` / `dm.hide()`
Shortcuts: `show()` calls `mount()`, `hide()` calls `unmount()`.

#### `dm.destroy()`
Stop the loop, remove the canvas, close the encoder/decoder.

#### `dm.mount(parent?)`
Append `dm.canvas` to a DOM element (defaults to `document.body`). Positions canvas absolutely at top-left. Throws an error if parent is not an HTMLElement.

#### `dm.unmount()`

---

## How it works

VP8/VP9/H.264/AV1 delta frames are encoded relative to a reference (the last keyframe the decoder received). Drop a frame before the decoder sees it and its reference stays stale — every subsequent delta is decoded against the wrong content, producing the characteristic datamosh smear.

`drop()` triggers this deliberately. `recover` schedules a clean keyframe after N frames to restore normal output.

`corrupt()` works differently: it zeroes out a region of a frame's encoded bitstream before decode. The decoder conceals the loss using surrounding block data, producing block corruption and color drift.

`hold` freezes the canvas by dropping all incoming chunks. On release, the pipeline skips keyframes and waits for the first delta to composite over the frozen image — a brief smear-on-freeze effect — before recovering.
