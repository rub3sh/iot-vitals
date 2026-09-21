// Heart-rate variability from a series of RR intervals (milliseconds).
//
// HRV measures the spacing between individual beats, not their average rate.
// Two people at the same bpm can differ enormously here: it reflects autonomic
// balance rather than cardiac output.

/**
 * Artefact filter. A missed beat doubles an interval and a double-counted one
 * halves it; both are common with an optical sensor and both wreck RMSSD,
 * which is a difference measure and therefore hypersensitive to exactly this.
 * Rejecting intervals that jump more than 20% against the running median is
 * the standard correction.
 */
export function cleanIntervals(rr) {
  const plausible = rr.filter((v) => v >= 300 && v <= 2000);
  if (plausible.length < 4) return plausible;

  const sorted = [...plausible].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  return plausible.filter((v) => Math.abs(v - median) <= 0.2 * median);
}

/** Root mean square of successive differences — the standard short-term metric. */
function rmssd(rr) {
  if (rr.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < rr.length; i++) {
    const d = rr[i] - rr[i - 1];
    sum += d * d;
  }
  return Math.sqrt(sum / (rr.length - 1));
}

/** Standard deviation of the intervals themselves — longer-term variability. */
function sdnn(rr) {
  if (rr.length < 2) return null;
  const mean = rr.reduce((a, b) => a + b, 0) / rr.length;
  const varr = rr.reduce((a, b) => a + (b - mean) ** 2, 0) / (rr.length - 1);
  return Math.sqrt(varr);
}

/** Share of successive pairs differing by more than 50 ms. */
function pnn50(rr) {
  if (rr.length < 2) return null;
  let n = 0;
  for (let i = 1; i < rr.length; i++) if (Math.abs(rr[i] - rr[i - 1]) > 50) n++;
  return (n / (rr.length - 1)) * 100;
}

/**
 * Poincare descriptors. SD1 is the spread perpendicular to the line of
 * identity (beat-to-beat change, equal to RMSSD/sqrt2); SD2 is the spread
 * along it (longer-term drift). Their ratio describes the cloud's shape, which
 * is what makes the plot readable at a glance.
 */
function poincare(rr) {
  if (rr.length < 3) return { sd1: null, sd2: null, ratio: null };
  const r = rmssd(rr);
  const s = sdnn(rr);
  if (r == null || s == null) return { sd1: null, sd2: null, ratio: null };
  const sd1 = r / Math.SQRT2;
  const inner = 2 * s * s - sd1 * sd1;
  const sd2 = inner > 0 ? Math.sqrt(inner) : 0;
  return { sd1, sd2, ratio: sd1 > 0 ? sd2 / sd1 : null };
}

export function computeHrv(rawIntervals) {
  const rr = cleanIntervals(rawIntervals);
  const rejected = rawIntervals.length - rr.length;

  // Below ~20 beats the metrics are too noisy to show. Say so rather than
  // printing a confident number built from six beats.
  if (rr.length < 20) {
    return {
      ready: false, beats: rr.length, rejected,
      needed: 20, rmssd: null, sdnn: null, pnn50: null,
      meanRr: null, meanBpm: null, sd1: null, sd2: null, ratio: null,
    };
  }

  const meanRr = rr.reduce((a, b) => a + b, 0) / rr.length;
  const { sd1, sd2, ratio } = poincare(rr);

  return {
    ready: true,
    beats: rr.length,
    rejected,
    rmssd: rmssd(rr),
    sdnn: sdnn(rr),
    pnn50: pnn50(rr),
    meanRr,
    meanBpm: 60000 / meanRr,
    sd1, sd2, ratio,
  };
}

/** Consecutive pairs for the Poincare scatter: (rr[n], rr[n+1]). */
export function poincarePairs(rawIntervals) {
  const rr = cleanIntervals(rawIntervals);
  const pairs = [];
  for (let i = 1; i < rr.length; i++) pairs.push([rr[i - 1], rr[i]]);
  return pairs;
}
