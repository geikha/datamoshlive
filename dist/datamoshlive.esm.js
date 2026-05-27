/**
 * DatamoshPipeline — VP8/VP9/H.264 VideoEncoder + VideoDecoder pair.
 *
 * Datamosh = deliberate reference-frame mismatch:
 *   1. Encoder produces a keyframe (resets its internal reference)
 *   2. That keyframe is DROPPED before the decoder sees it
 *   3. Decoder still has its old reference frame
 *   4. Incoming delta frames decoded against the stale reference →
 *      motion vectors paint old pixels into new positions → smearing
 *
 * smear()   — one-shot: force keyframe → drop it → auto-recover after ~30 delta frames
 * sync()    — force keyframe → deliver it → clean reference (cancels any pending smear)
 * corrupt() — corrupt the next delta frame's payload → packet-loss style artifact
 */

const CODEC_MAP = {
  vp8:  'vp8',
  vp9:  'vp09.00.10.08',
  h264: 'avc1.42001E',
};

function resolveCodec(name, fallback = 'vp8') {
  const mapped = CODEC_MAP[name];
  if (mapped) return mapped;

  // If not in map, validate it's a known codec string (vp8, vp9, or h26x variant)
  if (/^(vp8|vp09|avc1)/.test(name)) return name;

  console.warn(`DatamoshLive: unknown codec "${name}", falling back to previous codec`);
  return fallback;
}

// Parameter configuration: type, default, and bounds.
const PARAM_CONFIG = {
  speed:         { default: 2,        type: 'number', integer: true, min: 1 },
  enabled:       { default: true,     type: 'boolean' },
  smearRate:     { default: 0,        type: 'number', min: 0, max: 1 },
  corruptRate:   { default: 0,        type: 'number', min: 0, max: 1 },
  corruptAmount: { default: 0.3,      type: 'number', min: 0, max: 1 },
  hold:          { default: false,    type: 'boolean' },
  bitrate:       { default: 1_000_000, type: 'number', min: 1 },
  codec:         { default: 'vp8',    type: 'string' },
};

// Resolve a parameter: call if function, apply type coercion, bounds, defaults.
function resolveParam(paramValue, configKey) {
  const config = PARAM_CONFIG[configKey];
  if (!config) return paramValue;

  // Call if function, otherwise use as-is.
  let value = typeof paramValue === 'function' ? paramValue() : paramValue;

  // Use default for undefined or NaN.
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
    value = config.default;
  }

  // Type coercion.
  if (config.type === 'boolean') {
    value = !!value;
  } else if (config.type === 'number') {
    value = Number(value);
    if (!Number.isFinite(value)) value = config.default;

    if (config.integer) value = Math.round(value);
    if (config.min != null) value = Math.max(config.min, value);
    if (config.max != null) value = Math.min(config.max, value);
  }

  return value;
}

// Pick H.264 AVC level based on resolution (coded area in pixels).
// H.264 levels have maximum coded areas; higher resolution needs higher level.
function getH264CodecString(width, height) {
  const area = width * height;

  if (area <= 414720) {
    return 'avc1.42001E'; // Level 3.0
  } else if (area <= 921600) {
    return 'avc1.42001F'; // Level 3.1
  } else if (area <= 2560000) {
    return 'avc1.420028'; // Level 4.0
  } else {
    return 'avc1.420029'; // Level 4.1 (max ~2160p)
  }
}

class DatamoshPipeline {
  /**
   * @param {Object}   opts
   * @param {number}   opts.width
   * @param {number}   opts.height
   * @param {number}   opts.bitrate
   * @param {string}   opts.codec       - 'vp8' | 'vp9' | 'h264' | raw codec string
   * @param {Object}   opts.params      - live reference to DatamoshLive.params
   * @param {Function} opts.onFrame     - called with each decoded VideoFrame
   */
  constructor(opts) {
    this._params  = opts.params;
    this._onFrame = opts.onFrame;
    this._width   = opts.width;
    this._height  = opts.height;
    this._bitrate = opts.bitrate || 1_000_000;
    let codec = resolveCodec(opts.codec || 'vp8');
    // For H.264, pick AVC level based on resolution.
    if (codec.startsWith('avc')) {
      codec = getH264CodecString(this._width, this._height);
    }
    this._codec = codec;
    this._lastValidCodec = codec;
    this._encoder = null;
    this._decoder = null;
    this._nextKeyFrame        = true;
    this._dropNextKeyFrame    = false;
    this._deliverNextKeyFrame = false;
    this._gotFirstKeyFrame    = false;
    this._smearPending        = false;
    this._recoverAfterDeltas  = 0;
    this._corruptNext         = false;
    this._holding      = false;
    this._waitForDelta = false;
    this._init();
  }

  _init() {
    this._decoder = new VideoDecoder({
      output: (frame) => {
        this._onFrame(frame);
        frame.close();
      },
      error: (err) => {
        console.warn('DatamoshLive decoder:', err);
        if (this._decoder?.state === 'closed') {
          requestAnimationFrame(() => {
            this._init();
            this._nextKeyFrame = true;
            this._deliverNextKeyFrame = true;
          });
        }
      },
    });
    this._decoder.configure({ codec: this._codec });

    const encoderConfig = {
      codec:   this._codec,
      width:   this._width,
      height:  this._height,
      bitrate: this._bitrate,
    };
    // H.264: use Annex-B so SPS/PPS are embedded inline and decoder needs no description.
    if (this._codec.startsWith('avc')) {
      encoderConfig.avc = { format: 'annexb' };
    }

    this._encoder = new VideoEncoder({
      output: (chunk) => this._handleChunk(chunk),
      error: (err) => console.error('DatamoshLive encoder:', err),
    });
    this._encoder.configure(encoderConfig);

    this._nextKeyFrame        = true;
    this._dropNextKeyFrame    = false;
    this._deliverNextKeyFrame = false;
    this._gotFirstKeyFrame    = false;
    this._smearPending        = false;
    this._recoverAfterDeltas  = 0;
    this._corruptNext         = false;
    this._holding      = false;
    this._waitForDelta = false;
  }

  _handleChunk(chunk) {
    if (!this._decoder || this._decoder.state === 'closed') return;

    // Hold: drop all incoming chunks so the last drawn frame stays frozen on canvas.
    if (resolveParam(this._params.hold, 'hold')) {
      this._holding = true;
      return;
    }

    // After un-hold: skip keyframes and wait for the first delta to run over the frozen frame.
    if (this._waitForDelta) {
      if (chunk.type === 'key') return;
      this._processDeltaChunk(chunk);
      this._waitForDelta = false;
      return;
    }

    if (chunk.type === 'key') {
      // First keyframe ever — must be decoded to initialize decoder reference.
      if (!this._gotFirstKeyFrame) {
        this._gotFirstKeyFrame = true;
        this._decoder.decode(chunk);
        return;
      }

      // sync() override — deliver regardless of anything else.
      if (this._deliverNextKeyFrame) {
        this._deliverNextKeyFrame = false;
        this._dropNextKeyFrame    = false;
        this._smearPending        = false;
        this._recoverAfterDeltas  = 0;
        this._decoder.decode(chunk);
        return;
      }

      // smear() one-shot: drop this keyframe, start delta-frame recovery countdown.
      if (this._smearPending) {
        this._smearPending       = false;
        this._recoverAfterDeltas = 30;
        return;
      }

      // smearRate > 0: continuous probabilistic keyframe dropping.
      const smearRate = resolveParam(this._params.smearRate, 'smearRate');
      const shouldDrop = this._dropNextKeyFrame ||
        (smearRate > 0 && Math.random() < smearRate);
      if (shouldDrop) {
        this._dropNextKeyFrame = false;
        return;
      }

      this._decoder.decode(chunk);

    } else {
      this._processDeltaChunk(chunk);
    }
  }

  // Shared delta-frame processing: recovery countdown, corruption, and speed-decode.
  _processDeltaChunk(chunk) {
    if (this._recoverAfterDeltas > 0) {
      this._recoverAfterDeltas--;
      if (this._recoverAfterDeltas === 0) {
        this._nextKeyFrame        = true;
        this._deliverNextKeyFrame = true;
      }
    }

    let outChunk = chunk;
    const corruptRate   = resolveParam(this._params.corruptRate,   'corruptRate');
    const corruptAmount = resolveParam(this._params.corruptAmount, 'corruptAmount');

    if (this._corruptNext) {
      this._corruptNext = false;
      outChunk = this._corruptChunk(chunk, corruptAmount);
      this._recoverAfterDeltas = Math.max(this._recoverAfterDeltas, 30);
    } else if (corruptRate > 0 && Math.random() < corruptRate) {
      outChunk = this._corruptChunk(chunk, corruptAmount);
      this._recoverAfterDeltas = Math.max(this._recoverAfterDeltas, 30);
    }

    const speed = resolveParam(this._params.speed, 'speed');
    for (let i = 0; i < speed; i++) {
      if (!this._decoder || this._decoder.state === 'closed') break;
      try {
        this._decoder.decode(outChunk);
      } catch (_) {
        // Malformed chunk rejected by decoder — skip
      }
    }
  }

  // Zero out a contiguous byte region inside a delta frame, simulating packet loss.
  // First ~10 bytes (frame header) are preserved to reduce hard decoder crashes.
  _corruptChunk(chunk, amount = 0.3) {
    const size = chunk.byteLength;
    if (size < 20) return chunk;
    const buf  = new ArrayBuffer(size);
    chunk.copyTo(buf);
    const view = new Uint8Array(buf);
    const dataStart  = Math.min(10, size >> 1);
    const dataLen    = size - dataStart;
    const corruptLen = Math.max(1, Math.floor(dataLen * amount));
    const maxOffset  = dataLen - corruptLen;
    const start      = dataStart + Math.floor(Math.random() * maxOffset);
    view.fill(0, start, start + corruptLen);
    const init = { type: chunk.type, timestamp: chunk.timestamp, data: buf };
    if (chunk.duration != null) init.duration = chunk.duration;
    return new EncodedVideoChunk(init);
  }

  encode(frame) {
    if (!this._encoder || this._encoder.state === 'closed') return;

    // Detect hold toggle: if we were holding and now not, wait for the first delta.
    const prevHolding = this._holding;
    const nowHolding  = resolveParam(this._params.hold, 'hold');
    if (prevHolding && !nowHolding) {
      this._waitForDelta       = true;
      this._recoverAfterDeltas = Math.max(this._recoverAfterDeltas, 30);
    }
    this._holding = nowHolding;

    const keyFrame = this._nextKeyFrame;
    this._nextKeyFrame = false;
    this._encoder.encode(frame, { keyFrame });
  }

  // Force a keyframe and deliver it — cancels any pending smear, clean reference.
  sync() {
    this._nextKeyFrame        = true;
    this._dropNextKeyFrame    = false;
    this._deliverNextKeyFrame = true;
    this._smearPending        = false;
  }

  // Force a keyframe, drop it, then auto-recover after ~30 delta frames.
  smear() {
    this._nextKeyFrame = true;
    this._smearPending = true;
  }

  // Flag the next delta frame for payload corruption.
  corrupt() {
    this._corruptNext = true;
  }

  // Ask for the next encoded frame to be a keyframe.
  requestKeyFrame() {
    this._nextKeyFrame = true;
  }

  reset(width, height, bitrate, codec) {
    let resolutionChanged = false;
    if (width   != null) {
      this._width   = Math.max(1, Math.floor(width));
      resolutionChanged = true;
    }
    if (height  != null) {
      this._height  = Math.max(1, Math.floor(height));
      resolutionChanged = true;
    }
    if (bitrate != null) this._bitrate = Math.max(1, bitrate);
    if (codec   != null) {
      let resolved = resolveCodec(codec, this._lastValidCodec);
      // For H.264, recalculate AVC level based on new resolution.
      if (resolved.startsWith('avc')) {
        resolved = getH264CodecString(this._width, this._height);
      }
      this._codec = resolved;
      this._lastValidCodec = resolved;
    } else if (resolutionChanged && this._codec.startsWith('avc')) {
      // Resolution changed while using H.264 — recalculate appropriate AVC level.
      this._codec = getH264CodecString(this._width, this._height);
      this._lastValidCodec = this._codec;
    }
    try { if (this._encoder?.state !== 'closed') this._encoder.close(); } catch (_) {}
    try { if (this._decoder?.state !== 'closed') this._decoder.close(); } catch (_) {}
    this._init();
  }

  destroy() {
    try { if (this._encoder?.state !== 'closed') this._encoder.close(); } catch (_) {}
    try { if (this._decoder?.state !== 'closed') this._decoder.close(); } catch (_) {}
  }
}

/**
 * DatamoshInput — Manages the video/camera/canvas source and fit-mode drawing.
 */

const FIT_MODES = ['stretch', 'fill', 'fit'];

function drawFit(ctx, source, cw, ch, fit) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  if (!sw || !sh) return false;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);

  let dx, dy, dw, dh;
  const sa = sw / sh;
  const ta = cw / ch;

  switch (fit) {
    case 'stretch':
      dx = 0; dy = 0; dw = cw; dh = ch;
      break;
    case 'fill':
      if (sa > ta) { dh = ch; dw = dh * sa; }
      else         { dw = cw; dh = dw / sa; }
      dx = (cw - dw) / 2;
      dy = (ch - dh) / 2;
      break;
    case 'fit':
    default:
      if (sa > ta) { dw = cw; dh = dw / sa; }
      else         { dh = ch; dw = dh * sa; }
      dx = (cw - dw) / 2;
      dy = (ch - dh) / 2;
      break;
  }

  ctx.drawImage(source, dx, dy, dw, dh);
  return true;
}

class DatamoshInput {
  constructor() {
    this._source = null;
    this._type   = null;
    this._cameraStream = null;
    this._fit = 'stretch';
  }

  get hasSource() { return !!this._source; }

  get fit() { return this._fit; }
  set fit(v) {
    if (FIT_MODES.includes(v)) this._fit = v;
    else console.warn(`DatamoshInput: unknown fit "${v}"`);
  }

  setCamera(video, stream) {
    this._releaseSource();
    this._source = video;
    this._type   = 'camera';
    this._cameraStream = stream;
  }

  setVideo(video) {
    this._releaseSource();
    this._source = video;
    this._type   = 'video';
  }

  setCanvas(canvas) {
    this._releaseSource();
    this._source = canvas;
    this._type   = 'canvas';
  }

  // Draw the current source into ctx scaled to (w × h) with the active fit mode.
  capture(ctx, w, h) {
    if (!this._source) return false;
    return drawFit(ctx, this._source, w, h, this._fit);
  }

  // Pause and detach any playing video/camera source, then stop camera tracks.
  _releaseSource() {
    if (this._source && (this._type === 'camera' || this._type === 'video')) {
      try {
        this._source.pause();
        this._source.srcObject = null;
        this._source.src = '';
      } catch (_) {}
    }
    this._stopCamera();
    this._source = null;
    this._type   = null;
  }

  _stopCamera() {
    if (this._cameraStream) {
      this._cameraStream.getTracks().forEach(t => t.stop());
      this._cameraStream = null;
    }
  }

  destroy() {
    this._releaseSource();
  }
}

/**
 * DatamoshLive — Real-time datamosh effect using WebCodecs (VP8 / VP9 / H.264).
 *
 *   const dm = new DatamoshLive({ renderWidth: 640, renderHeight: 480 });
 *   await dm.initCamera();
 *   dm.smear();        // one-shot smear, auto-recovers
 *   dm.smearRate = 0.5 // continuous probabilistic smearing (0 = off)
 */


const DEFAULT_PARAMS = {
  speed:         1,      // times each delta frame is decoded (smear strength)
  enabled:       true,   // false = bypass codec, draw source directly
  smearRate:     0,      // probability (0–1) a keyframe is dropped each cycle; 0 = off
  corruptRate:   0,      // probability (0–1) a delta frame is corrupted each cycle; 0 = off
  corruptAmount: 0.3,    // fraction (0–1) of frame bytes to zero out per corruption
  hold:          false,
  bitrate:       1_000_000,
  codec:         'vp8',
};

// Encoder queue depth multiplier: if the queue exceeds fps * this factor we consider
// ourselves overloaded and drop the frame. Keeps the threshold relative to the
// configured frame rate so normal bursts don't trigger it.
const QUEUE_OVERLOAD_FACTOR = 2;

class DatamoshLive {
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

    // If the encoder is severely backed up (more than 2× the configured fps worth of
    // frames queued), drop this frame and sync to a clean state to prevent the backlog
    // from draining all at once and causing a visual rush.
    const overloadThreshold = Math.max(8, this._fps * QUEUE_OVERLOAD_FACTOR);
    if ((this._pipeline._encoder?.encodeQueueSize ?? 0) > overloadThreshold) {
      this._pipeline.sync();
      return;
    }

    this._frameCount++;

    // Force periodic keyframes when smearRate > 0 — gives the drop logic frames to work with.
    if (this._resolveParam('smearRate') > 0 && this._frameCount % 60 === 0) {
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
    try {
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
    } catch (err) {
      console.warn('DatamoshLive.initCamera:', err);
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
      }
    } catch (err) {
      console.warn('DatamoshLive.initVideo:', err);
    }
  }

  async initCanvas(canvas, opts = {}) {
    try {
      this._input.setCanvas(canvas);
      this._frameCount = 0;
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

  setParam(name, value) {
    if (!(name in this.params)) console.warn(`DatamoshLive: unknown param "${name}"`);
    this.params[name] = value;
    if (name === 'bitrate') this._pipeline.reset(null, null, value);
    if (name === 'codec') {
      this._pipeline.reset(null, null, null, value);
      this._pipeline.sync(); // deliver a clean keyframe immediately after codec switch
    }
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

  /**
   * Probability (0–1) that a keyframe is dropped each cycle.
   * Set to 0 to disable continuous smearing.
   */
  get smearRate()      { return this.params.smearRate; }
  set smearRate(v)     { this.params.smearRate = Math.max(0, Math.min(1, v)); }

  /**
   * Probability (0–1) that a delta frame is corrupted each cycle.
   * Set to 0 to disable continuous corruption.
   */
  get corruptRate()    { return this.params.corruptRate; }
  set corruptRate(v)   { this.params.corruptRate = Math.max(0, Math.min(1, v)); }

  get corruptAmount()  { return this.params.corruptAmount; }
  set corruptAmount(v) { this.params.corruptAmount = Math.max(0, Math.min(1, v)); }

  get hold()           { return this.params.hold; }
  set hold(v)          { this.params.hold = !!v; }

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

  get width()          { return this.renderWidth; }
  set width(v)         { this.setResolution(v, this.renderHeight); }

  get height()         { return this.renderHeight; }
  set height(v)        { this.setResolution(this.renderWidth, v); }

  // Force keyframe + deliver it → clean sync, cancels any pending smear.
  sync()    { this._pipeline.sync(); }

  // Force keyframe + drop it → datamosh smear that auto-recovers in ~30 frames.
  smear()   { this._pipeline.smear(); }

  // Corrupt the next delta frame → packet-loss style artifact.
  corrupt() { this._pipeline.corrupt(); }

  // ---- Render size (encoder / decoder dimensions) ----

  setResolution(width, height) {
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

  resizeCanvas(width, height) {
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

export { DatamoshLive as default };
