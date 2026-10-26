// Small deterministic statistics helpers for the evaluation scripts.
import crypto from "crypto";

// mulberry32 seeded from a string/number; returns () => [0, 1).
export function createRng(seed = 42) {
  let a = parseInt(crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 8), 16) >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng, n) {
  return Math.min(n - 1, Math.floor(rng() * n));
}

export function mean(values) {
  if (!values.length) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, (sortedValues.length - 1) * p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (idx - lo);
}

export function percentileCi(samples, level = 0.95) {
  const sorted = [...samples].sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return [percentile(sorted, tail), percentile(sorted, 1 - tail)];
}

// Percentile bootstrap CI of the mean of `values`.
export function bootstrapMeanCi(values, rng, iterations = 1000, level = 0.95) {
  if (values.length < 2) return [null, null];
  const n = values.length;
  const samples = new Array(iterations);
  for (let b = 0; b < iterations; b += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += values[randInt(rng, n)];
    samples[b] = sum / n;
  }
  return percentileCi(samples, level);
}

// Percentile bootstrap CI of mean(a) - mean(b), resampling each independently.
export function bootstrapDiffCi(a, b, rng, iterations = 1000, level = 0.95) {
  if (a.length < 2 || b.length < 2) return [null, null];
  const samples = new Array(iterations);
  for (let k = 0; k < iterations; k += 1) {
    let sa = 0;
    let sb = 0;
    for (let i = 0; i < a.length; i += 1) sa += a[randInt(rng, a.length)];
    for (let i = 0; i < b.length; i += 1) sb += b[randInt(rng, b.length)];
    samples[k] = sa / a.length - sb / b.length;
  }
  return percentileCi(samples, level);
}
