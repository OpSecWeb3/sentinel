/**
 * Prometheus metrics — shared across API and worker.
 *
 * Exposes: request latency, queue depth, job counters, connection pool stats.
 * Scraped via GET /metrics on the API server.
 */
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const register = new Registry();

// Collect Node.js defaults (event loop lag, GC, memory, etc.)
collectDefaultMetrics({ register });

// ── HTTP request metrics (API) ────────────────────────────────────────

export const httpRequestDuration = new Histogram({
  name: 'sentinel_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const httpRequestsTotal = new Counter({
  name: 'sentinel_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [register],
});

// ── Queue metrics (worker) ────────────────────────────────────────────

export const jobsProcessedTotal = new Counter({
  name: 'sentinel_jobs_processed_total',
  help: 'Total jobs processed',
  labelNames: ['queue', 'jobName', 'status'] as const,
  registers: [register],
});

export const jobDuration = new Histogram({
  name: 'sentinel_job_duration_seconds',
  help: 'Job processing duration in seconds',
  labelNames: ['queue', 'jobName'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [register],
});

export const queueDepth = new Gauge({
  name: 'sentinel_queue_depth',
  help: 'Number of waiting jobs in queue',
  labelNames: ['queue'] as const,
  registers: [register],
});

// ── Dead-letter metrics ───────────────────────────────────────────────

export const deadLetterTotal = new Counter({
  name: 'sentinel_dead_letter_total',
  help: 'Jobs moved to dead-letter after exhausting retries',
  labelNames: ['queue', 'jobName'] as const,
  registers: [register],
});

// ── Connection pool metrics ───────────────────────────────────────────

export const dbPoolSize = new Gauge({
  name: 'sentinel_db_pool_size',
  help: 'Database connection pool size',
  labelNames: ['state'] as const,
  registers: [register],
});
