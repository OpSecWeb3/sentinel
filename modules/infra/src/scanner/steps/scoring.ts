/**
 * Re-export from the canonical scoring module location.
 * The scoring logic lives at ../scoring.ts, not in the steps directory.
 */
export { calculateScore, applySuppressions, type FindingSuppression } from '../scoring.js';
