import { CHANNELS, CHANNEL_NAMES, type ChannelName, type ChannelValues, type Sample } from '@speicherlotse/telemetry-model';

/** Bump when the JSON shape changes in a way old readers cannot handle. */
export const WIRE_VERSION = 1;

/** A batch is at most this many samples. Protects readers from absurd messages. */
export const MAX_SAMPLES_PER_BATCH = 100;

// ── Kafka topics and clock limits shared by the services ───────────

/** Kafka topic for batches that passed validation (written by ingest, read by the writer and the alarm engine). */
export const RAW_TOPIC = 'telemetry.raw';
/** Kafka topic for messages we refused, with the reason. Nothing is silently dropped. */
export const REJECTED_TOPIC = 'telemetry.rejected';

/**
 * A device clock outside 2000..2100 is treated as unset or broken (a device that never synchronised sends 1970).
 * The writer rejects such samples instead of creating chunks for the year 1970; the alarm engine ignores them.
 */
export const CLOCK_MIN_MS = Date.UTC(2000, 0, 1);
export const CLOCK_MAX_MS = Date.UTC(2100, 0, 1);
export const clockIsPlausible = (wallMs: number): boolean => wallMs >= CLOCK_MIN_MS && wallMs < CLOCK_MAX_MS;

// ── topics ──────────────────────────────────────────────────────────

export function topicFor(deviceId: number): string {
  return `speicherlotse/v1/devices/${deviceId}/telemetry`;
}

/** Subscribers use this filter to receive every device. `+` matches exactly one topic level. */
export const TELEMETRY_FILTER = 'speicherlotse/v1/devices/+/telemetry';

const TOPIC_RE = /^speicherlotse\/v1\/devices\/(\d+)\/telemetry$/;

/** Returns the device id in a telemetry topic, or null if the topic is not one of ours. */
export function parseTopic(topic: string): { deviceId: number } | null {
  const m = TOPIC_RE.exec(topic);
  if (!m) return null;
  const deviceId = Number(m[1]);
  return Number.isSafeInteger(deviceId) && deviceId > 0 ? { deviceId } : null;
}

// ── encode ──────────────────────────────────────────────────────────

/**
 * One MQTT message = one batch of samples from ONE device and ONE boot.
 * On the wire, channels are keyed by their stable numeric id (see CHANNELS), not by name,
 * so renaming a channel in code never breaks stored or in-flight data.
 */
export function encodeBatch(samples: readonly Sample[]): string {
  const first = samples[0];
  if (first === undefined) throw new Error('encodeBatch: a batch needs at least one sample');
  if (samples.length > MAX_SAMPLES_PER_BATCH) throw new Error('encodeBatch: batch too large');
  for (const s of samples) {
    if (s.deviceId !== first.deviceId || s.bootId !== first.bootId) {
      throw new Error('encodeBatch: all samples in a batch must share deviceId and bootId');
    }
  }
  return JSON.stringify({
    v: WIRE_VERSION,
    deviceId: first.deviceId,
    bootId: first.bootId,
    samples: samples.map((s) => ({
      seq: s.seq,
      wallMs: s.wallMs,
      monoMs: s.monoMs,
      values: toWireValues(s.values),
    })),
  });
}

function toWireValues(values: ChannelValues): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of CHANNEL_NAMES) {
    const v = values[name];
    if (v !== undefined) out[String(CHANNELS[name].id)] = v;
  }
  return out;
}

// ── decode ──────────────────────────────────────────────────────────

export type DecodeResult =
  | { ok: true; samples: Sample[] }
  | { ok: false; reason: string };

const ID_TO_NAME = new Map<number, ChannelName>(CHANNEL_NAMES.map((n) => [CHANNELS[n].id, n]));

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x);

/**
 * Strict about structure, lenient about values:
 *  - a broken envelope (bad JSON, wrong version, missing ids, empty batch) rejects the whole message;
 *  - an unknown channel id or a non-numeric value is skipped, because a device with newer firmware
 *    may send channels we do not know yet, and an alarm rule treats a missing channel as "unknown".
 * Plausibility (is 900 °C a real battery temperature?) is NOT checked here; that is the rule layer's job.
 */
export function decodeBatch(payload: string): DecodeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  if (!isObject(raw)) return { ok: false, reason: 'payload is not an object' };
  if (raw.v !== WIRE_VERSION) return { ok: false, reason: `unsupported wire version ${String(raw.v)}` };

  const { deviceId, bootId, samples } = raw;
  if (!isInt(deviceId) || deviceId <= 0) return { ok: false, reason: 'deviceId must be a positive integer' };
  if (!isInt(bootId) || bootId < 0) return { ok: false, reason: 'bootId must be a non-negative integer' };
  if (!Array.isArray(samples) || samples.length === 0) return { ok: false, reason: 'samples must be a non-empty array' };
  if (samples.length > MAX_SAMPLES_PER_BATCH) return { ok: false, reason: 'batch too large' };

  const out: Sample[] = [];
  for (const [i, s] of samples.entries()) {
    if (!isObject(s)) return { ok: false, reason: `sample ${i} is not an object` };
    const { seq, wallMs, monoMs, values } = s;
    if (!isInt(seq) || seq < 0) return { ok: false, reason: `sample ${i}: bad seq` };
    if (typeof wallMs !== 'number' || !Number.isFinite(wallMs)) return { ok: false, reason: `sample ${i}: bad wallMs` };
    if (typeof monoMs !== 'number' || !Number.isFinite(monoMs) || monoMs < 0) return { ok: false, reason: `sample ${i}: bad monoMs` };
    if (!isObject(values)) return { ok: false, reason: `sample ${i}: values is not an object` };

    const parsed: ChannelValues = {};
    for (const [key, v] of Object.entries(values)) {
      const name = ID_TO_NAME.get(Number(key));
      if (name === undefined) continue;                              // unknown channel: skip
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;    // null, string, NaN: skip
      parsed[name] = v;
    }
    out.push({ deviceId, bootId, seq, wallMs, monoMs, values: parsed });
  }
  return { ok: true, samples: out };
}