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

export default class DatamoshInput {
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
