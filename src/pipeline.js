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

import { resolveParam, PARAM_CONFIG } from './params.js';
import { resolveCodec, getCodecString } from './codec.js';

export { resolveParam, PARAM_CONFIG };

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

    // Bootstrap: decoder needs one keyframe to establish its initial reference,
    // even while holding — otherwise hold could swallow the only keyframe ever
    // requested and starve the decoder permanently once un-held.
    if (!this._gotFirstKeyFrame) {
      if (chunk.type !== 'key') return;
      this._gotFirstKeyFrame = true;
      this._decoder.decode(chunk);
      return;
    }

    // Hold: drop everything, freeze last drawn frame. Resumes on whatever
    // chunk arrives next once un-held — no special-cased wait state.
    if (resolveParam(this._params.hold, 'hold')) {
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

    // Inject: replay sample buffer instead of encoding the live frame.
    if (this._injecting) {
      if (resolveParam(this._params.hold, 'hold') || this._sampleBuffer.length === 0) return;
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
