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

export function resolveCodec(name) {
  return CODEC_MAP[name] || name;
}

export { PARAM_CONFIG, resolveParam };

// Parameter configuration: type, default, and bounds.
const PARAM_CONFIG = {
  speed:         { default: 2,        type: 'number', integer: true, min: 1 },
  enabled:       { default: true,     type: 'boolean' },
  autoSmear:     { default: false,    type: 'boolean' },
  smearRate:     { default: 0.5,      type: 'number', min: 0, max: 1 },
  autoCorrupt:   { default: false,    type: 'boolean' },
  corruptRate:   { default: 0.5,      type: 'number', min: 0, max: 1 },
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

export default class DatamoshPipeline {
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
    this._encoder = null;
    this._decoder = null;
    this._nextKeyFrame        = true;
    this._dropNextKeyFrame    = false;
    this._deliverNextKeyFrame = false;
    this._gotFirstKeyFrame    = false;
    this._smearPending        = false;
    this._recoverAfterDeltas  = 0;
    this._corruptNext         = false;
    this._holding      = !!this._params.hold;
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
    this._holding      = !!this._params.hold;
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

      // autoSmear: probabilistic continuous drop.
      const shouldDrop = this._dropNextKeyFrame ||
        (resolveParam(this._params.autoSmear, 'autoSmear') && Math.random() < resolveParam(this._params.smearRate, 'smearRate'));
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
    if (this._corruptNext) {
      this._corruptNext = false;
      outChunk = this._corruptChunk(chunk, resolveParam(this._params.corruptAmount, 'corruptAmount'));
      this._recoverAfterDeltas = Math.max(this._recoverAfterDeltas, 30);
    } else if (resolveParam(this._params.autoCorrupt, 'autoCorrupt') && Math.random() < resolveParam(this._params.corruptRate, 'corruptRate')) {
      outChunk = this._corruptChunk(chunk, resolveParam(this._params.corruptAmount, 'corruptAmount'));
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
      let resolved = resolveCodec(codec);
      // For H.264, recalculate AVC level based on new resolution.
      if (resolved.startsWith('avc')) {
        resolved = getH264CodecString(this._width, this._height);
      }
      this._codec = resolved;
    } else if (resolutionChanged && this._codec.startsWith('avc')) {
      // Resolution changed while using H.264 — recalculate appropriate AVC level.
      this._codec = getH264CodecString(this._width, this._height);
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
