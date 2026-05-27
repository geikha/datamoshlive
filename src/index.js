/**
 * DatamoshLive — Real-time datamosh effect using WebCodecs (VP8 / VP9 / H.264).
 *
 *   const dm = new DatamoshLive({ renderWidth: 640, renderHeight: 480 });
 *   await dm.initCamera();
 *   dm.smear();           // one-shot smear, auto-recovers
 *   dm.autoSmear = true;  // continuous probabilistic smearing
 */

import DatamoshPipeline, { resolveCodec, resolveParam } from './pipeline.js';
import DatamoshInput from './input.js';

const DEFAULT_PARAMS = {
  speed:         1,      // times each delta frame is decoded (smear strength)
  enabled:       true,   // false = bypass codec, draw source directly
  autoSmear:     false,  // continuously drop keyframes at random → persistent smear
  smearRate:     0.5,    // probability (0–1) a keyframe is dropped when autoSmear is on
  autoCorrupt:   false,  // continuously corrupt delta frame payloads → packet-loss artifacts
  corruptRate:   0.5,    // probability (0–1) a delta frame is corrupted when autoCorrupt is on
  corruptAmount: 0.3,    // fraction (0–1) of frame bytes to zero out per corruption
  hold:          false,
  bitrate:       1_000_000,
  codec:         'vp8',
};

export default class DatamoshLive {
  /**
   * @param {Object} opts
   * @param {number}  [opts.renderWidth=640]   - Encoder / processing width
   * @param {number}  [opts.renderHeight=480]  - Encoder / processing height
   * @param {number}  [opts.displayWidth]      - Output canvas width  (defaults to renderWidth)
   * @param {number}  [opts.displayHeight]     - Output canvas height (defaults to renderHeight)
   * @param {HTMLCanvasElement} [opts.canvas]  - Existing canvas element to use
   * @param {Object}  [opts.params]            - Initial parameter overrides
   */
  constructor(opts = {}) {
    const rw = opts.renderWidth  || opts.width  || 640;
    const rh = opts.renderHeight || opts.height || 480;

    this.renderWidth  = rw;
    this.renderHeight = rh;
    this.displayWidth  = opts.displayWidth  || rw;
    this.displayHeight = opts.displayHeight || rh;

    this._looping       = false;
    this._rafId         = null;
    this._shown         = false;
    this._lastFrameTime = null;
    this._fps           = 30;
    this._frameInterval = 1000 / 30;
    this._frameCount    = 0;

    this.params = { ...DEFAULT_PARAMS, ...(opts.params || {}) };

    this.canvas = opts.canvas || document.createElement('canvas');
    this.canvas.width  = this.displayWidth;
    this.canvas.height = this.displayHeight;
    this._ctx = this.canvas.getContext('2d');

    this._offscreen       = document.createElement('canvas');
    this._offscreen.width  = this.renderWidth;
    this._offscreen.height = this.renderHeight;
    this._offscreenCtx    = this._offscreen.getContext('2d');

    this._input = new DatamoshInput();

    this._pipeline = new DatamoshPipeline({
      width:   this.renderWidth,
      height:  this.renderHeight,
      bitrate: this.params.bitrate,
      codec:   this.params.codec,
      params:  this.params,
      onFrame: (frame) => {
        this._ctx.drawImage(frame, 0, 0, this.displayWidth, this.displayHeight);
      },
    });
  }

  // ---- Per-frame capture ----

  _captureFrame() {
    if (!this._input.hasSource) return;

    const enabled = this._resolveParam('enabled');
    if (!enabled) {
      this._input.capture(this._ctx, this.displayWidth, this.displayHeight);
      return;
    }

    this._frameCount++;

    // Force periodic keyframes when autoSmear is on — gives the drop logic frames to work with
    if (this._resolveParam('autoSmear') && this._frameCount % 60 === 0) {
      this._pipeline.requestKeyFrame();
    }

    const drawn = this._input.capture(this._offscreenCtx, this.renderWidth, this.renderHeight);
    if (!drawn) return;

    if (this._pipeline._encoder?.state === 'closed') return;

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

  async initCamera(opts = {}) {
    const constraints = opts.constraints || {
      video: { width: { ideal: this.renderWidth }, height: { ideal: this.renderHeight } },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const video  = document.createElement('video');
    video.srcObject   = stream;
    video.muted       = true;
    video.playsInline = true;
    await video.play();
    this._input.setCamera(video, stream);
    this._frameCount = 0;
    this._pipeline.reset();
    if (opts.autoStart !== false) this.start();
    return video;
  }

  initVideo(source, opts = {}) {
    if (typeof source === 'string') {
      return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.src         = source;
        video.crossOrigin = 'anonymous';
        video.muted       = true;
        video.loop        = true;
        video.playsInline = true;
        video.addEventListener('loadeddata', () => {
          this._input.setVideo(video);
          video.play().catch(() => {});
          this._frameCount = 0;
          this._pipeline.reset();
          if (opts.autoStart !== false) this.start();
          resolve();
        }, { once: true });
        video.addEventListener('error', () =>
          reject(new Error('Failed to load video: ' + source)), { once: true });
      });
    } else {
      this._input.setVideo(source);
      this._frameCount = 0;
      this._pipeline.reset();
      if (opts.autoStart !== false) this.start();
      return Promise.resolve();
    }
  }

  initCanvas(canvas, opts = {}) {
    this._input.setCanvas(canvas);
    this._frameCount = 0;
    this._pipeline.reset();
    if (opts.autoStart !== false) this.start();
  }

  // ---- Parameters ----

  _resolveParam(name) {
    return resolveParam(this.params[name], name);
  }

  setParam(name, value) {
    if (!(name in this.params)) console.warn(`DatamoshLive: unknown param "${name}"`);
    this.params[name] = value;
    if (name === 'bitrate') this._pipeline.reset(null, null, value);
    if (name === 'codec')   this._pipeline.reset(null, null, null, value);
  }

  setParams(obj) {
    for (const key in obj) this.setParam(key, obj[key]);
  }

  get speed()          { return this.params.speed; }
  set speed(v)         { this.params.speed = v; }

  get enabled()        { return this.params.enabled; }
  set enabled(v) {
    if (v && !this.params.enabled) this._pipeline.sync();
    this.params.enabled = v;
  }

  get autoSmear()      { return this.params.autoSmear; }
  set autoSmear(v)     { this.params.autoSmear = !!v; }

  get smearRate()      { return this.params.smearRate; }
  set smearRate(v)     { this.params.smearRate = Math.max(0, Math.min(1, v)); }

  get autoCorrupt()    { return this.params.autoCorrupt; }
  set autoCorrupt(v)   { this.params.autoCorrupt = !!v; }

  get hold()            { return this.params.hold; }
  set hold(v)          { this.params.hold = v; }

  get corruptRate()    { return this.params.corruptRate; }
  set corruptRate(v)   { this.params.corruptRate = Math.max(0, Math.min(1, v)); }

  get corruptAmount()  { return this.params.corruptAmount; }
  set corruptAmount(v) { this.params.corruptAmount = Math.max(0, Math.min(1, v)); }

  get bitrate()        { return this.params.bitrate; }
  set bitrate(v)       { this.setParam('bitrate', v); }

  get codec()          { return this.params.codec; }
  set codec(v)         { this.setParam('codec', v); }

  get fit()            { return this._input.fit; }
  set fit(v)           { this._input.fit = v; }

  get fps()            { return this._fps; }
  set fps(v)           { this.setFPS(v); }

  get width()          { return this.renderWidth; }
  set width(v)         { this.setRenderSize(v, this.renderHeight); }

  get height()         { return this.renderHeight; }
  set height(v)        { this.setRenderSize(this.renderWidth, v); }

  setFPS(fps) {
    this._fps = Math.max(0, Number(fps) || 0);
    this._frameInterval = this._fps > 0 ? 1000 / this._fps : 0;
  }

  // Force keyframe + deliver it → clean sync, cancels any pending smear.
  sync() { this._pipeline.sync(); }

  // Force keyframe + drop it → datamosh smear that auto-recovers in ~30 frames.
  smear() { this._pipeline.smear(); }

  // Corrupt the next delta frame → packet-loss style artifact.
  corrupt() { this._pipeline.corrupt(); }

  // ---- Render size (encoder / decoder dimensions) ----

  setRenderSize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.renderWidth && h === this.renderHeight) return;
    this.renderWidth       = w;
    this.renderHeight      = h;
    this._offscreen.width  = w;
    this._offscreen.height = h;
    this._offscreenCtx = this._offscreen.getContext('2d');
    this._pipeline.reset(w, h);
  }

  // ---- Display size (output canvas physical dimensions) ----

  setDisplaySize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.displayWidth && h === this.displayHeight) return;
    this.displayWidth  = w;
    this.displayHeight = h;
    this.canvas.width  = w;
    this.canvas.height = h;
    this._ctx = this.canvas.getContext('2d');
  }

  // ---- Loop control ----

  start() {
    if (this._looping) return;
    this._looping = true;
    this._lastFrameTime = null;
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

  show() {
    if (this._shown) return;
    this._shown = true;
    document.body.appendChild(this.canvas);
  }

  hide() {
    if (!this._shown) return;
    this._shown = false;
    this.canvas.parentNode?.removeChild(this.canvas);
  }

  destroy() {
    this.stop();
    this.hide();
    this._pipeline.destroy();
    this._input.destroy();
  }
}
