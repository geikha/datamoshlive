// Parameter configuration: type, default, and bounds.
const PARAM_CONFIG = {
  speed:         { default: 1,         type: 'number', integer: true, min: 1 },
  enabled:       { default: true,      type: 'boolean' },
  dropRate:      { default: 0,         type: 'number', min: 0, max: 1 },
  corruptRate:   { default: 0,         type: 'number', min: 0, max: 1 },
  corruptAmount: { default: 0.3,       type: 'number', min: 0, max: 1 },
  hold:          { default: false,     type: 'boolean' },
  recover:       { default: true,      type: 'boolean' },
  recoverAfter:  { default: 30,        type: 'number', integer: true, min: 1 },
  sampleFrames:  { default: 1,         type: 'number', integer: true, min: 1 },
  sampleLoop:    { default: false,     type: 'boolean' },
  bitrate:       { default: 1_000_000, type: 'number', min: 1 },
  codec:         { default: 'vp8',     type: 'string' },
};

// Resolve a parameter value: call if function, apply type coercion, bounds, defaults.
function resolveParam(paramValue, configKey) {
  const config = PARAM_CONFIG[configKey];
  if (!config) return paramValue;

  let value = typeof paramValue === 'function' ? paramValue() : paramValue;

  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
    value = config.default;
  }

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

const CODEC_MAP = {
  vp8:  'vp8',
  vp9:  'vp09',
  h264: 'avc1',
  av1:  'av01',
};

// Validate/normalize a codec name to a base identifier or specific codec string.
// Accepts friendly names (via CODEC_MAP), base identifiers, or raw WebCodecs strings.
function resolveCodec(name, fallback = 'vp8') {
  const mapped = CODEC_MAP[name];
  if (mapped) return mapped;
  if (/^(vp8|vp09|avc1|av01)/.test(name)) return name;
  console.warn(`DatamoshLive: unknown codec "${name}", falling back to previous codec`);
  return fallback;
}

// Given a codec base identifier (or specific string) and resolution, return the
// fully-specified WebCodecs codec string appropriate for that frame size.
function getCodecString(codec, width, height) {
  if (codec.startsWith('avc1')) return getH264CodecString(width, height);
  if (codec.startsWith('vp09')) return getVP9CodecString(width, height);
  if (codec.startsWith('av01')) return getAV1CodecString(width, height);
  return codec; // vp8 has no level parameter
}

// H.264 Baseline Profile (42), level selected by frame area.
// Hex level values: 1E=30, 1F=31, 28=40, 32=50, 33=51.
function getH264CodecString(width, height) {
  const area = width * height;
  if (area <= 414720)  return 'avc1.42001E'; // Level 3.0: ≤720×576
  if (area <= 921600)  return 'avc1.42001F'; // Level 3.1: ≤1280×720
  if (area <= 2097152) return 'avc1.420028'; // Level 4.0: ≤1080p
  if (area <= 5652480) return 'avc1.420032'; // Level 5.0: ≤~2560×2160
  return 'avc1.420033';                       // Level 5.1: 4K+
}

// VP9 Profile 0 (4:2:0 8-bit), level selected by frame area.
function getVP9CodecString(width, height) {
  const area = width * height;
  if (area <= 552960)  return 'vp09.00.30.08'; // Level 3.0: ≤~768×720
  if (area <= 983040)  return 'vp09.00.31.08'; // Level 3.1: ≤1280×768
  if (area <= 2228224) return 'vp09.00.40.08'; // Level 4.0: ≤~1920×1160
  if (area <= 8912896) return 'vp09.00.51.08'; // Level 5.1: ≤4K
  return 'vp09.00.62.08';                       // Level 6.2: >4K
}

// AV1 Main Profile, Main Tier, 8-bit, level selected by frame area.
// Level index → level name: 00=2.0, 01=2.1, 04=3.0, 05=3.1, 08=4.0, 12=5.0, 16=6.0.
function getAV1CodecString(width, height) {
  const area = width * height;
  if (area <= 147456)  return 'av01.0.00M.08'; // Level 2.0: ≤~384×384
  if (area <= 278528)  return 'av01.0.01M.08'; // Level 2.1: ≤~528×528
  if (area <= 665600)  return 'av01.0.04M.08'; // Level 3.0: ≤~816×816
  if (area <= 1105920) return 'av01.0.05M.08'; // Level 3.1: ≤~1052×1052
  if (area <= 2359296) return 'av01.0.08M.08'; // Level 4.0: ≤~1536×1536
  if (area <= 8912896) return 'av01.0.12M.08'; // Level 5.0: ≤4K
  return 'av01.0.16M.08';                       // Level 6.0: >4K
}

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
 * drop()    — one-shot: drop next frame → auto-recover after recoverAfter frames
 * sync()    — force keyframe → deliver it → clean reference (cancels any pending drop)
 * corrupt() — corrupt the next frame's payload → packet-loss style artifact
 * sample(n) — capture the next n encoded frames into a reusable buffer
 * inject()  — loop the sample buffer instead of encoding new frames
 */


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
    this._codec   = this._resolveCodec(opts.codec || 'vp8');
    this._lastValidCodec = this._codec;
    this._sampleBuffer = [];
    this._init();
  }

  // Reset all per-stream effect/state flags to their initial values.
  // Note: _sampleBuffer is intentionally preserved across resets.
  _resetState() {
    this._nextKeyFrame        = true;
    this._deliverNextKeyFrame = false;
    this._gotFirstKeyFrame    = false;
    this._dropNext            = false;
    this._recoverAfterDeltas  = 0;
    this._corruptNext         = false;
    this._holding             = false;
    this._waitForDelta        = false;
    this._samplesNeeded       = 0;
    this._injecting           = false;
    this._injectIndex         = 0;
  }

  // Trigger auto-recovery if enabled: schedule a clean keyframe after recoverAfter frames.
  _startRecovery() {
    if (!resolveParam(this._params.recover, 'recover')) return;
    const after = resolveParam(this._params.recoverAfter, 'recoverAfter');
    this._recoverAfterDeltas = Math.max(this._recoverAfterDeltas, after);
  }

  // Resolve a codec name to the resolution-appropriate WebCodecs codec string.
  _resolveCodec(codec) {
    return getCodecString(resolveCodec(codec, this._lastValidCodec), this._width, this._height);
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
    if (this._codec.startsWith('avc1')) {
      encoderConfig.avc = { format: 'annexb' };
    }

    this._encoder = new VideoEncoder({
      output: (chunk) => this._handleChunk(chunk),
      error: (err) => {
        console.warn('DatamoshLive encoder:', err);
        if (this._encoder?.state === 'closed') {
          requestAnimationFrame(() => this._init());
        }
      },
    });
    this._encoder.configure(encoderConfig);

    this._resetState();
  }

  _handleChunk(chunk) {
    if (!this._decoder || this._decoder.state === 'closed') return;

    // Hold: drop everything, freeze last drawn frame.
    if (resolveParam(this._params.hold, 'hold')) {
      this._holding = true;
      return;
    }

    // After un-hold: skip keyframes until the first delta runs over the frozen image.
    if (this._waitForDelta) {
      if (chunk.type === 'key') return;
      this._waitForDelta = false;
    }

    // Bootstrap: decoder needs one keyframe to establish its initial reference.
    if (!this._gotFirstKeyFrame) {
      if (chunk.type !== 'key') return;
      this._gotFirstKeyFrame = true;
      this._decoder.decode(chunk);
      return;
    }

    // sync() or recovery: deliver this keyframe clean, cancel all pending ops.
    if (this._deliverNextKeyFrame && chunk.type === 'key') {
      this._deliverNextKeyFrame = false;
      this._dropNext            = false;
      this._recoverAfterDeltas  = 0;
      this._decoder.decode(chunk);
      return;
    }

    // --- Drop (one-shot or rate-based, any frame type) ---
    if (this._dropNext) {
      this._dropNext = false;
      this._startRecovery();
      return;
    }
    const dropRate = resolveParam(this._params.dropRate, 'dropRate');
    if (dropRate > 0 && Math.random() < dropRate) {
      this._startRecovery();
      return;
    }

    // --- Corrupt (one-shot or rate-based, any frame type) ---
    let outChunk = chunk;
    if (this._corruptNext) {
      this._corruptNext = false;
      outChunk = this._corruptChunk(chunk, resolveParam(this._params.corruptAmount, 'corruptAmount'));
      this._startRecovery();
    } else {
      const corruptRate = resolveParam(this._params.corruptRate, 'corruptRate');
      if (corruptRate > 0 && Math.random() < corruptRate) {
        outChunk = this._corruptChunk(chunk, resolveParam(this._params.corruptAmount, 'corruptAmount'));
        this._startRecovery();
      }
    }

    // --- Recovery countdown ---
    if (this._recoverAfterDeltas > 0) {
      this._recoverAfterDeltas--;
      if (this._recoverAfterDeltas === 0) {
        this._nextKeyFrame        = true;
        this._deliverNextKeyFrame = true;
      }
    }

    // --- Sample: capture a copy of the post-effect chunk while processing normally ---
    if (this._samplesNeeded > 0) {
      const buf = new ArrayBuffer(outChunk.byteLength);
      outChunk.copyTo(buf);
      const init = { type: outChunk.type, timestamp: outChunk.timestamp, data: buf };
      if (outChunk.duration != null) init.duration = outChunk.duration;
      this._sampleBuffer.push(new EncodedVideoChunk(init));
      this._samplesNeeded--;
    }

    // --- Decode (speed only multiplies delta frames) ---
    const speed = chunk.type === 'key' ? 1 : resolveParam(this._params.speed, 'speed');
    for (let i = 0; i < speed; i++) {
      if (!this._decoder || this._decoder.state === 'closed') break;
      try { this._decoder.decode(outChunk); } catch (_) {}
    }
  }

  // Zero out a contiguous byte region, simulating packet loss.
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

    const prevHolding = this._holding;
    const nowHolding  = resolveParam(this._params.hold, 'hold');
    if (prevHolding && !nowHolding) {
      this._waitForDelta = true;
      this._startRecovery();
    }
    this._holding = nowHolding;

    // Inject: replay sample buffer instead of encoding the live frame.
    if (this._injecting) {
      if (nowHolding || this._sampleBuffer.length === 0) return;
      const sampleLoop = resolveParam(this._params.sampleLoop, 'sampleLoop');
      const bufLen = this._sampleBuffer.length;
      if (this._injectIndex >= bufLen && !sampleLoop) {
        this._injecting = false;
        return;
      }
      const chunk = this._sampleBuffer[this._injectIndex % bufLen];
      this._injectIndex++;
      const speed = chunk.type === 'key' ? 1 : resolveParam(this._params.speed, 'speed');
      for (let i = 0; i < speed; i++) {
        if (!this._decoder || this._decoder.state === 'closed') break;
        try { this._decoder.decode(chunk); } catch (_) {}
      }
      return;
    }

    const keyFrame = this._nextKeyFrame;
    this._nextKeyFrame = false;
    this._encoder.encode(frame, { keyFrame });
  }

  // Force a keyframe and deliver it — cancels any pending drop, clean reference.
  sync() {
    this._nextKeyFrame        = true;
    this._deliverNextKeyFrame = true;
    this._dropNext            = false;
  }

  // Drop the next incoming frame and start recovery.
  drop() { this._dropNext = true; }

  // Flag the next frame for payload corruption.
  corrupt() { this._corruptNext = true; }

  // Ask for the next encoded frame to be a keyframe.
  requestKeyFrame() { this._nextKeyFrame = true; }

  // Capture the next n post-effect encoded frames into the sample buffer.
  sample(n) {
    this._injecting     = false;
    this._injectIndex   = 0;
    this._sampleBuffer  = [];
    this._samplesNeeded = Math.max(1, n);
  }

  // Start replaying the sample buffer instead of the live feed.
  // Plays once then stops unless sampleLoop is true. Also triggers recovery.
  inject() {
    if (this._sampleBuffer.length === 0) return;
    this._injecting   = true;
    this._injectIndex = 0;
    this._startRecovery();
  }

  // Stop injection and resume normal live encoding.
  stopInject() { this._injecting = false; }

  reset(width, height, bitrate, codec) {
    let resolutionChanged = false;
    if (width   != null) { this._width  = Math.max(1, Math.floor(width));  resolutionChanged = true; }
    if (height  != null) { this._height = Math.max(1, Math.floor(height)); resolutionChanged = true; }
    if (bitrate != null) this._bitrate = Math.max(1, bitrate);
    if (codec   != null) {
      this._codec = this._resolveCodec(codec);
      this._lastValidCodec = this._codec;
    } else if (resolutionChanged) {
      this._codec = getCodecString(this._codec, this._width, this._height);
      this._lastValidCodec = this._codec;
    }
    this._closeCodecs();
    this._init();
  }

  destroy() {
    this._closeCodecs();
    this._sampleBuffer = [];
  }

  // Close encoder and decoder if open, swallowing teardown errors.
  _closeCodecs() {
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
 *   const dm = new DatamoshLive({ width: 640, height: 480 });
 *   await dm.initCamera();
 *   dm.drop();         // one-shot frame drop, auto-recovers
 *   dm.dropRate = 0.5  // continuous probabilistic dropping (0 = off)
 */


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

class DatamoshLive {
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
    this._frameCount    = 0;

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

    // If the encoder is severely backed up (more than 2× the configured fps worth of
    // frames queued), drop this frame and sync to a clean state to prevent the backlog
    // from draining all at once and causing a visual rush.
    const overloadThreshold = Math.max(8, this._fps * QUEUE_OVERLOAD_FACTOR);
    if ((this._pipeline._encoder?.encodeQueueSize ?? 0) > overloadThreshold) {
      this._pipeline.sync();
      return;
    }

    this._frameCount++;

    const drawn = this._input.capture(this._offscreenCtx, this.width, this.height);
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

  async initCamera(selector = 0, opts = {}) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((d) => d.kind === 'videoinput');

      let device;
      if (typeof selector === 'number') {
        device = cameras[selector];
      } else if (typeof selector === 'string') {
        // Exact match first
        device = cameras.find((d) => d.label === selector);
        // Fallback to includes match
        if (!device) {
          device = cameras.find((d) => d.label.toLowerCase().includes(selector.toLowerCase()));
        }
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
          this._frameCount = 0;
          this._pipeline.reset();
          if (opts.autoStart !== false) this.start();
          resolve(video);
        };

        const onError = (e) => {
          cleanup();
          console.warn('DatamoshLive.initCamera: video error:', e);
          resolve(video);
        };

        video.addEventListener('loadeddata', onLoadedData, { once: true });
        video.addEventListener('error', onError, { once: true });
        video.play().catch((e) => {
          console.warn('DatamoshLive.initCamera: play() blocked:', e);
        });
      });
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
   * Probability (0–1) that any incoming frame is dropped each cycle.
   * Set to 0 to disable continuous dropping.
   */
  get dropRate()       { return this.params.dropRate; }
  set dropRate(v)      { this.params.dropRate = Math.max(0, Math.min(1, v)); }

  /**
   * Probability (0–1) that any incoming frame is corrupted each cycle.
   * Set to 0 to disable continuous corruption.
   */
  get corruptRate()    { return this.params.corruptRate; }
  set corruptRate(v)   { this.params.corruptRate = Math.max(0, Math.min(1, v)); }

  get corruptAmount()  { return this.params.corruptAmount; }
  set corruptAmount(v) { this.params.corruptAmount = Math.max(0, Math.min(1, v)); }

  get hold()           { return this.params.hold; }
  set hold(v)          { this.params.hold = v; }

  get recover()        { return this.params.recover; }
  set recover(v)       { this.params.recover = v; }

  get recoverAfter()   { return this.params.recoverAfter; }
  set recoverAfter(v)  { this.params.recoverAfter = v; }

  get sampleFrames()   { return this.params.sampleFrames; }
  set sampleFrames(v) {
    const n = Math.max(1, Math.round(Number(v) || 1));
    if (n !== this.params.sampleFrames) {
      this._pipeline.stopInject();
      this.params.sampleFrames = n;
    }
  }

  get sampleLoop()     { return this.params.sampleLoop; }
  set sampleLoop(v)    { this.params.sampleLoop = !!v; }

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
