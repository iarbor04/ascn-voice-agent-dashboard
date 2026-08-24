function sinc(value) {
  if (value === 0) return 1;
  const scaled = Math.PI * value;
  return Math.sin(scaled) / scaled;
}

// Оконный синк: подавляет зеркальные частоты, из-за которых понижение
// частоты линейной интерполяцией звучит хрипом.
function kernel(offset, halfWidth) {
  if (Math.abs(offset) > halfWidth) return 0;
  return sinc(offset) * 0.5 * (1 + Math.cos(Math.PI * offset / halfWidth));
}

export function resamplePcm16(buffer, fromRate, toRate) {
  const samples = Math.floor(buffer.length / 2);
  if (fromRate === toRate || !samples) return buffer;
  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.round(samples / ratio));
  const output = Buffer.alloc(outputLength * 2);
  const scale = Math.max(1, ratio);
  const halfWidth = 3;
  const taps = Math.ceil(halfWidth * scale);
  for (let index = 0; index < outputLength; index += 1) {
    const center = index * ratio;
    const first = Math.floor(center) - taps;
    const last = Math.floor(center) + taps;
    let acc = 0;
    let norm = 0;
    for (let position = first; position <= last; position += 1) {
      const weight = kernel((center - position) / scale, halfWidth);
      if (!weight) continue;
      const clamped = Math.min(samples - 1, Math.max(0, position));
      acc += buffer.readInt16LE(clamped * 2) * weight;
      norm += weight;
    }
    const value = norm ? acc / norm : 0;
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), index * 2);
  }
  return output;
}

const LIMIT_KNEE = 26000;
const LIMIT_RANGE = 6000;

// Мягкое ограничение вместо обрезания: на пиках нет щелчков.
function limit(value) {
  if (value > LIMIT_KNEE) return LIMIT_KNEE + (value - LIMIT_KNEE) / (1 + (value - LIMIT_KNEE) / LIMIT_RANGE);
  if (value < -LIMIT_KNEE) return -LIMIT_KNEE - (-value - LIMIT_KNEE) / (1 + (-value - LIMIT_KNEE) / LIMIT_RANGE);
  return value;
}

export function applyGain(buffer, gain) {
  if (!gain || gain === 1) return buffer;
  const output = Buffer.alloc(buffer.length - (buffer.length % 2));
  for (let offset = 0; offset + 1 < output.length; offset += 2) {
    const value = limit(buffer.readInt16LE(offset) * gain);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), offset);
  }
  return output;
}
