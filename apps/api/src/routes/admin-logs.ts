import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '@sentinel/shared/hono-types';
import { requireRole } from '../middleware/rbac.js';
import {
  isDockerAvailable,
  listContainers,
  fetchContainerLogs,
} from '../lib/docker.js';

const router = new Hono<AppEnv>();

router.use('*', requireRole('admin'));

router.get('/containers', async (c) => {
  if (!isDockerAvailable()) {
    return c.json({ error: 'Docker socket not available', containers: [] });
  }
  try {
    const containers = await listContainers();
    return c.json({ containers });
  } catch (err) {
    return c.json(
      {
        error: `Failed to list containers: ${err instanceof Error ? err.message : 'unknown'}`,
        containers: [],
      },
      500,
    );
  }
});

router.get('/', async (c) => {
  if (!isDockerAvailable()) {
    return c.json({ error: 'Docker socket not available', logs: [] });
  }

  const service = c.req.query('service');
  if (!service) {
    throw new HTTPException(400, { message: 'service query param is required' });
  }

  const tail = Math.min(
    Math.max(parseInt(c.req.query('tail') ?? '200', 10) || 200, 1),
    5000,
  );
  const since = c.req.query('since') || undefined;
  const search = c.req.query('search') || undefined;
  const stream = (c.req.query('stream') ?? 'all') as 'all' | 'stdout' | 'stderr';

  if (!['all', 'stdout', 'stderr'].includes(stream)) {
    throw new HTTPException(400, { message: 'stream must be all, stdout, or stderr' });
  }

  try {
    // Exact match: the UI populates `service` from the listContainers
    // dropdown, so the client always sends a full container name. Equality
    // removes the "which sentinel-api-* wins?" ambiguity if a future
    // container shares a prefix.
    const containers = await listContainers();
    const container = containers.find((ctr) => ctr.name === service);
    if (!container) {
      return c.json({ error: `No container matching "${service}"`, logs: [] });
    }

    let logs = await fetchContainerLogs({
      containerId: container.id,
      containerName: container.name,
      tail,
      since,
      stream,
    });

    if (search) {
      const lower = search.toLowerCase();
      logs = logs.filter((l) => l.message.toLowerCase().includes(lower));
    }

    return c.json({
      container: { id: container.id, name: container.name },
      logs,
    });
  } catch (err) {
    return c.json(
      {
        error: `Failed to fetch logs: ${err instanceof Error ? err.message : 'unknown'}`,
        logs: [],
      },
      500,
    );
  }
});

export { router as adminLogsRouter };
