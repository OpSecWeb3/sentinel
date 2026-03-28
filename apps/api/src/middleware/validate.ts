/**
 * Zod validation middleware for Hono.
 * Ported from ChainAlert's validate.ts — consistent 400 error format.
 */
import type { Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ZodSchema, ZodError } from 'zod';
import type { AuthContext } from '@sentinel/shared/hono-types';

type ValidationTarget = 'json' | 'query' | 'param';

function formatZodError(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

export function validate<S extends ZodSchema>(target: ValidationTarget, schema: S) {
  return async (c: AuthContext, next: Next) => {
    let data: unknown;

    switch (target) {
      case 'json':
        data = await c.req.json().catch(() => null);
        if (data === null) {
          throw new HTTPException(400, { message: 'Invalid JSON body' });
        }
        break;
      case 'query': {
        const url = new URL(c.req.url);
        data = Object.fromEntries(url.searchParams.entries());
        break;
      }
      case 'param':
        data = c.req.param();
        break;
    }

    const result = schema.safeParse(data);
    if (!result.success) {
      const body = {
        error: 'Validation failed',
        details: formatZodError(result.error),
      };
      throw new HTTPException(400, {
        res: new Response(JSON.stringify(body), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      });
    }

    const key = `validated_${target}` as 'validated_json' | 'validated_query' | 'validated_param';
    c.set(key, result.data);
    await next();
  };
}

/** Type-safe getter for validated data */
export function getValidated<T>(c: AuthContext, target: ValidationTarget): T {
  const key = `validated_${target}` as 'validated_json' | 'validated_query' | 'validated_param';
  const value = c.get(key);
  if (value === undefined) {
    throw new HTTPException(500, {
      message: `getValidated('${target}') called without a preceding validate('${target}') middleware`,
    });
  }
  return value as T;
}
