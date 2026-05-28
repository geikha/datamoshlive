// Parameter configuration: type, default, and bounds.
export const PARAM_CONFIG = {
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
export function resolveParam(paramValue, configKey) {
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
