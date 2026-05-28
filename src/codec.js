export const CODEC_MAP = {
  vp8:  'vp8',
  vp9:  'vp09',
  h264: 'avc1',
  av1:  'av01',
};

// Validate/normalize a codec name to a base identifier or specific codec string.
// Accepts friendly names (via CODEC_MAP), base identifiers, or raw WebCodecs strings.
export function resolveCodec(name, fallback = 'vp8') {
  const mapped = CODEC_MAP[name];
  if (mapped) return mapped;
  if (/^(vp8|vp09|avc1|av01)/.test(name)) return name;
  console.warn(`DatamoshLive: unknown codec "${name}", falling back to previous codec`);
  return fallback;
}

// Given a codec base identifier (or specific string) and resolution, return the
// fully-specified WebCodecs codec string appropriate for that frame size.
export function getCodecString(codec, width, height) {
  if (codec.startsWith('avc1')) return getH264CodecString(width, height);
  if (codec.startsWith('vp09')) return getVP9CodecString(width, height);
  if (codec.startsWith('av01')) return getAV1CodecString(width, height);
  return codec; // vp8 has no level parameter
}

// H.264 Baseline Profile (42), level selected by frame area.
// Hex level values: 1E=30, 1F=31, 28=40, 32=50, 33=51.
export function getH264CodecString(width, height) {
  const area = width * height;
  if (area <= 414720)  return 'avc1.42001E'; // Level 3.0: ≤720×576
  if (area <= 921600)  return 'avc1.42001F'; // Level 3.1: ≤1280×720
  if (area <= 2097152) return 'avc1.420028'; // Level 4.0: ≤1080p
  if (area <= 5652480) return 'avc1.420032'; // Level 5.0: ≤~2560×2160
  return 'avc1.420033';                       // Level 5.1: 4K+
}

// VP9 Profile 0 (4:2:0 8-bit), level selected by frame area.
export function getVP9CodecString(width, height) {
  const area = width * height;
  if (area <= 552960)  return 'vp09.00.30.08'; // Level 3.0: ≤~768×720
  if (area <= 983040)  return 'vp09.00.31.08'; // Level 3.1: ≤1280×768
  if (area <= 2228224) return 'vp09.00.40.08'; // Level 4.0: ≤~1920×1160
  if (area <= 8912896) return 'vp09.00.51.08'; // Level 5.1: ≤4K
  return 'vp09.00.62.08';                       // Level 6.2: >4K
}

// AV1 Main Profile, Main Tier, 8-bit, level selected by frame area.
// Level index → level name: 00=2.0, 01=2.1, 04=3.0, 05=3.1, 08=4.0, 12=5.0, 16=6.0.
export function getAV1CodecString(width, height) {
  const area = width * height;
  if (area <= 147456)  return 'av01.0.00M.08'; // Level 2.0: ≤~384×384
  if (area <= 278528)  return 'av01.0.01M.08'; // Level 2.1: ≤~528×528
  if (area <= 665600)  return 'av01.0.04M.08'; // Level 3.0: ≤~816×816
  if (area <= 1105920) return 'av01.0.05M.08'; // Level 3.1: ≤~1052×1052
  if (area <= 2359296) return 'av01.0.08M.08'; // Level 4.0: ≤~1536×1536
  if (area <= 8912896) return 'av01.0.12M.08'; // Level 5.0: ≤4K
  return 'av01.0.16M.08';                       // Level 6.0: >4K
}
