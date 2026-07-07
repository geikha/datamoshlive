/**
 * DatamoshLive — Real-time datamosh effect using WebCodecs (VP8 / VP9 / H.264).
 *
 *   const dm = new DatamoshLive({ width: 640, height: 480 });
 *   await dm.initCam();
 *   dm.drop();         // one-shot frame drop, auto-recovers
 *   dm.dropRate = 0.5  // continuous probabilistic dropping (0 = off)
 */

import DatamoshPipeline, { resolveParam, coerceParam } from './pipeline.js';
import DatamoshInput from './input.js';

const DEFAULT_PARAMS = {
  speed:         1,      // times each delta frame is decoded (smear strength)
  enabled:       true,   // false = bypass codec, draw source directly
  dropRate:      0,      // probability (0–1) any frame is dropped each cycle; 0 = off
  corruptRate:   0,      // probability (0–1) a frame is corrupted each cycle; 0 = off
  corruptAmount: 0.3,    // fraction (0–1) of frame bytes to zero out per corruption
  hold:          false,
  recover:       true,   // whether to auto-recover after drops/corruptions
  recoverAfter:  null,   // frames before recovery keyframe; null = live function (= fps or 30)
  sampleFrames:  1,      // default number of frames captured by sample()
  sampleLoop:    false,  // if true, inject() loops the sample buffer; if false, plays once then stops
  bitrate:       1_000_000,
  codec:         'vp8',
};

// Encoder queue depth multiplier: if the queue exceeds fps * this factor we consider
// ourselves overloaded and drop the frame. Keeps the threshold relative to the
// configured frame rate so normal bursts don't trigger it.
const QUEUE_OVERLOAD_FACTOR = 2;

export default class DatamoshLive {
  /**
   * @param {Object} opts
   * @param {number}  [opts.width=640]         - Encoder / processing width
   * @param {number}  [opts.height=480]        - Encoder / processing height
   * @param {number}  [opts.canvasWidth]       - Output canvas width  (defaults to width)
   * @param {number}  [opts.canvasHeight]      - Output canvas height (defaults to height)
   * @param {HTMLCanvasElement} [opts.canvas]  - Existing canvas element to use
   * @param {Object}  [opts.params]            - Initial parameter overrides
   */
  constructor(opts = {}) {
    const w = opts.width  || 640;
    const h = opts.height || 480;

    this.width  = w;
    this.height = h;
    this.canvasWidth  = opts.canvasWidth  || w;
    this.canvasHeight = opts.canvasHeight || h;

    this._looping       = false;
    this._rafId         = null;
    this._shown         = false;
    this._lastFrameTime = null;
    this._fps           = 30;
    this._frameInterval = 1000 / 30;

    this.params = { ...DEFAULT_PARAMS, ...(opts.params || {}) };
    if (this.params.recoverAfter == null) {
      this.params.recoverAfter = () => this._fps > 0 ? this._fps : 30;
    }

    this.canvas = opts.canvas || document.createElement('canvas');
    this.canvas.width  = this.canvasWidth;
    this.canvas.height = this.canvasHeight;
    this._ctx = this.canvas.getContext('2d');

    this._offscreen       = document.createElement('canvas');
    this._offscreen.width  = this.width;
    this._offscreen.height = this.height;
    this._offscreenCtx    = this._offscreen.getContext('2d');

    this._input = new DatamoshInput();

    this._pipeline = new DatamoshPipeline({
      width:   this.width,
      height:  this.height,
      bitrate: this.params.bitrate,
      codec:   this.params.codec,
      params:  this.params,
      onFrame: (frame) => {
        this._ctx.drawImage(frame, 0, 0, this.canvasWidth, this.canvasHeight);
      },
    });
  }

  // ---- Per-frame capture ----

  _captureFrame() {
    if (!this._input.hasSource) return;

    const enabled = this._resolveParam('enabled');
    if (!enabled) {
      this._input.capture(this._ctx, this.canvasWidth, this.canvasHeight);
      return;
    }

    // inject() replays the sample buffer instead of the live feed — step the
    // replay directly, skipping the capture/VideoFrame allocation the live
    // path needs (it would just be discarded unused).
    if (this._pipeline.isInjecting) {
      this._pipeline.stepInject();
      return;
    }

    // If the encoder is severely backed up (more than 2× the configured fps worth of
    // frames queued), drop this frame and sync to a clean state to prevent the backlog
    // from draining all at once and causing a visual rush.
    const effectiveFps = this._fps > 0 ? this._fps : 60;
    const overloadThreshold = Math.max(8, effectiveFps * QUEUE_OVERLOAD_FACTOR);
    if (this._pipeline.isOverloaded(overloadThreshold)) {
      this._pipeline.sync();
      return;
    }

    if (this._pipeline.isClosed) return;

    const drawn = this._input.capture(this._offscreenCtx, this.width, this.height);
    if (!drawn) return;

    let frame;
    try {
      frame = new VideoFrame(this._offscreen, {
        timestamp: Math.round(performance.now() * 1000),
      });
    } catch (_) {
      return;
    }

    this._pipeline.encode(frame);
    frame.close();
  }

  // ---- Source init ----

  async initCam(selector = 0, opts = {}) {
    try {
      async function getCameras() {
        let devices = await navigator.mediaDevices.enumerateDevices();
        let cameras = devices.filter((d) => d.kind === 'videoinput');
        if (!cameras.some((d) => d.deviceId)) {
          // Permission not yet granted — trigger prompt, stop immediately, re-enumerate
          const temp = await navigator.mediaDevices.getUserMedia({ video: true });
          temp.getTracks().forEach((t) => t.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
          cameras = devices.filter((d) => d.kind === 'videoinput');
        }
        return cameras;
      }

      const cameras = await getCameras();

      let device;
      if (typeof selector === 'number') {
        device = cameras[selector];
      } else if (typeof selector === 'string') {
        device = cameras.find((d) => d.label === selector);
        if (!device) device = cameras.find((d) => d.label.toLowerCase().includes(selector.toLowerCase()));
      }

      if (!device && cameras.length === 0) {
        console.warn('DatamoshLive.initCam: no cameras found');
        return;
      }

      const constraints = opts.constraints || {
        video: device
          ? { deviceId: { exact: device.deviceId }, width: { ideal: this.width }, height: { ideal: this.height } }
          : { width: { ideal: this.width }, height: { ideal: this.height } },
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;

      return new Promise((resolve) => {
        const cleanup = () => {
          video.removeEventListener('loadeddata', onLoadedData);
          video.removeEventListener('error', onError);
        };

        const onLoadedData = () => {
          cleanup();
          this._input.setCamera(video, stream);
          this._pipeline.reset();
          if (opts.autoStart !== false) this.start();
          resolve(video);
        };

        const onError = (e) => {
          cleanup();
          console.warn('DatamoshLive.initCam: video error:', e);
          resolve(video);
        };

        video.addEventListener('loadeddata', onLoadedData, { once: true });
        video.addEventListener('error', onError, { once: true });
        video.play().catch((e) => {
          console.warn('DatamoshLive.initCam: play() blocked:', e);
        });
      });
    } catch (err) {
      const msg = `Camera error: ${err.name || 'unknown'} - ${err.message || err}`;
      console.error('DatamoshLive.initCam:', msg);
      throw err;
    }
  }

  async initVideo(source, opts = {}) {
    try {
      if (typeof source === 'string') {
        await new Promise((resolve, reject) => {
          const video = document.createElement('video');
          video.src         = source;
          video.crossOrigin = 'anonymous';
          video.muted       = true;
          video.loop        = true;
          video.playsInline = true;
          video.addEventListener('loadeddata', () => {
            this._input.setVideo(video);
            video.play().catch(() => {});
            this._pipeline.reset();
            if (opts.autoStart !== false) this.start();
            resolve();
          }, { once: true });
          video.addEventListener('error', () =>
            reject(new Error('Failed to load video: ' + source)), { once: true });
        });
      } else {
        this._input.setVideo(source);
        this._pipeline.reset();
        if (opts.autoStart !== false) this.start();
      }
    } catch (err) {
      console.warn('DatamoshLive.initVideo:', err);
    }
  }

  async initCanvas(canvas, opts = {}) {
    try {
      this._input.setCanvas(canvas);
      this._pipeline.reset();
      if (opts.autoStart !== false) this.start();
    } catch (err) {
      console.warn('DatamoshLive.initCanvas:', err);
    }
  }

  // ---- Parameters ----

  _resolveParam(name) {
    return resolveParam(this.params[name], name);
  }

  // Single write path for every param: coerces plain values against PARAM_CONFIG
  // (type, bounds, defaults) while leaving live function values untouched, so
  // this.params always holds either a valid value or a valid live resolver —
  // never the kind of out-of-range value a caller could read back and be misled by.
  setParam(name, value) {
    if (!(name in this.params)) console.warn(`DatamoshLive: unknown param "${name}"`);
    const resolved = typeof value === 'function' ? value : coerceParam(value, name);
    this.params[name] = resolved;
    if (name === 'bitrate') this._pipeline.reset(null, null, resolved);
    if (name === 'codec') {
      this._pipeline.reset(null, null, null, resolved);
      this._pipeline.sync(); // deliver a clean keyframe immediately after codec switch
    }
  }

  setParams(obj) {
    for (const key in obj) this.setParam(key, obj[key]);
  }

  get speed()          { return this.params.speed; }
  set speed(v)         { this.setParam('speed', v); }

  get enabled()        { return this.params.enabled; }
  set enabled(v) {
    const wasEnabled = resolveParam(this.params.enabled, 'enabled');
    this.setParam('enabled', v);
    if (resolveParam(this.params.enabled, 'enabled') && !wasEnabled) this._pipeline.sync();
  }

  /**
   * Probability (0–1) that any incoming frame is dropped each cycle.
   * Set to 0 to disable continuous dropping.
   */
  get dropRate()       { return this.params.dropRate; }
  set dropRate(v)      { this.setParam('dropRate', v); }

  /**
   * Probability (0–1) that any incoming frame is corrupted each cycle.
   * Set to 0 to disable continuous corruption.
   */
  get corruptRate()    { return this.params.corruptRate; }
  set corruptRate(v)   { this.setParam('corruptRate', v); }

  get corruptAmount()  { return this.params.corruptAmount; }
  set corruptAmount(v) { this.setParam('corruptAmount', v); }

  get hold()           { return this.params.hold; }
  set hold(v)          { this.setParam('hold', v); }

  get recover()        { return this.params.recover; }
  set recover(v)       { this.setParam('recover', v); }

  get recoverAfter()   { return this.params.recoverAfter; }
  set recoverAfter(v)  { this.setParam('recoverAfter', v); }

  get sampleFrames()   { return this.params.sampleFrames; }
  set sampleFrames(v) {
    const n = coerceParam(v, 'sampleFrames');
    if (n !== this.params.sampleFrames) {
      this._pipeline.stopInject();
      this.setParam('sampleFrames', n);
    }
  }

  get sampleLoop()     { return this.params.sampleLoop; }
  set sampleLoop(v)    { this.setParam('sampleLoop', v); }

  get bitrate()        { return this.params.bitrate; }
  set bitrate(v)       { this.setParam('bitrate', v); }

  get codec()          { return this.params.codec; }
  set codec(v)         { this.setParam('codec', v); }

  get fit()            { return this._input.fit; }
  set fit(v)           { this._input.fit = v; }

  get fps()            { return this._fps; }
  set fps(v) {
    this._fps = Math.max(0, Number(v) || 0);
    this._frameInterval = this._fps > 0 ? 1000 / this._fps : 0;
  }


  // Force keyframe + deliver it → clean sync, cancels any pending drop.
  sync()    { this._pipeline.sync(); }

  // Drop the next incoming frame → datamosh artifact, auto-recovers if recover is enabled.
  drop()    { this._pipeline.drop(); }

  // Corrupt the next incoming frame → packet-loss style artifact.
  corrupt() { this._pipeline.corrupt(); }

  // Capture the next n (default: sampleFrames) post-effect encoded frames into a reusable buffer.
  sample(n) { this._pipeline.sample(n != null ? n : this._resolveParam('sampleFrames')); }

  // Start replaying the sample buffer on every encode call instead of the live feed.
  inject()     { this._pipeline.inject(); }

  // Stop injection and resume normal live encoding.
  stopInject() { this._pipeline.stopInject(); }

  // ---- Render size (encoder / decoder dimensions) ----

  setResolution(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;
    this.width       = w;
    this.height      = h;
    this._offscreen.width  = w;
    this._offscreen.height = h;
    this._offscreenCtx = this._offscreen.getContext('2d');
    this._pipeline.reset(w, h);
  }

  // ---- Display size (output canvas physical dimensions) ----

  resizeCanvas(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.canvasWidth && h === this.canvasHeight) return;
    this.canvasWidth  = w;
    this.canvasHeight = h;
    this.canvas.width  = w;
    this.canvas.height = h;
    this._ctx = this.canvas.getContext('2d');
  }

  // ---- Loop control ----

  start() {
    // Always reset timing so the first capture fires immediately after (re)start,
    // and sync the pipeline to a clean state — this fixes the case where start()
    // is called while already running (e.g. after a source swap + pipeline reset).
    this._lastFrameTime = null;
    this._pipeline.sync();

    if (this._looping) return; // loop is already ticking; timing reset above is enough
    this._looping = true;

    const loop = (ts) => {
      if (!this._looping) return;
      const delta = this._lastFrameTime === null ? Infinity : ts - this._lastFrameTime;
      if (this._frameInterval <= 0 || delta >= this._frameInterval) {
        this._captureFrame();
        this._lastFrameTime = this._lastFrameTime === null
          ? ts
          : ts - (this._frameInterval > 0 ? delta % this._frameInterval : 0);
      }
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  stop() {
    this._looping = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  // ---- Display ----

  mount(parent = document.body) {
    if (!parent || !(parent instanceof HTMLElement)) {
      throw new Error('DatamoshLive.mount: parent must be an HTMLElement');
    }
    if (this.canvas.parentNode !== parent) {
      parent.appendChild(this.canvas);
      this.canvas.style.position = 'absolute';
      this.canvas.style.top = '0';
      this.canvas.style.left = '0';
    }
    this._shown = true;
  }

  unmount() {
    if (this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    this._shown = false;
  }

  show() {
    this.mount();
  }

  hide() {
    this.unmount();
  }

  destroy() {
    this.stop();
    this.hide();
    this._pipeline.destroy();
    this._input.destroy();
  }
}
