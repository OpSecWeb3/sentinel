/**
 * Re-export from the canonical probe module location.
 * The probe logic lives at ../probe.ts, not in the steps directory.
 */
export { probeHost, probeResultToRecord, type ProbeOptions } from '../probe.js';
