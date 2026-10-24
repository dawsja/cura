/**
 * Shared plumbing for the MCP tools: argument types, result shapes, error
 * mapping, and a typed `registerTool` front.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/** Who a server instance acts for: the token's user, and the token itself for audit logs. */
export interface McpContext {
  userId: string;
  tokenId: string;
  canWrite: boolean;
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Changes data the user can see and redo in the app (a category, a planned amount). */
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Changes that replace or remove something the user set up. */
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

export const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM');
export const CalendarDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'must be YYYY-MM-DD');
export const TxType = z.enum(['income', 'expense', 'transfer']);

/** Current ledger month in the deployment timezone. */
export function currentYearMonth(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: env.TZ, year: 'numeric', month: '2-digit' })
    .format(now)
    .slice(0, 7);
}

/** An error the agent should see verbatim (bad argument, unknown id, conflict). */
export function userError(message: string, status: 400 | 404 | 409 = 400): Error {
  return Object.assign(new Error(message), { status });
}

function toolResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Data-layer errors carrying a 4xx `status` are user-facing (bad filter,
 * unknown id); anything else is logged and reported generically. Write
 * tools are logged on success as an audit trail of what each token changed.
 */
export function run<A>(
  name: string,
  ctx: McpContext,
  fn: (args: A) => Promise<Record<string, unknown>>,
  options: { audit?: boolean } = {},
) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      const result = await fn(args);
      if (options.audit) {
        logger.info({ event: 'mcp.write', tool: name, userId: ctx.userId, tokenId: ctx.tokenId }, 'mcp: write tool ran');
      }
      return toolResult(result);
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return toolError((err as Error).message || 'request failed');
      }
      logger.error({ err, tool: name, userId: ctx.userId, tokenId: ctx.tokenId }, 'mcp: tool failed');
      return toolError('internal error while running this tool');
    }
  };
}

interface ToolConfig<S extends z.ZodRawShape> {
  title: string;
  description: string;
  inputSchema?: S;
  annotations: ToolAnnotations;
}

type RegisterTool = (
  name: string,
  config: ToolConfig<z.ZodRawShape>,
  handler: (args: unknown) => Promise<CallToolResult>,
) => void;

/**
 * Typed front for `McpServer.registerTool`. The SDK's own signature infers
 * across zod v3 and v4 shapes, which makes `tsc` exhaust memory with this
 * many tools; inferring from our zod shape here keeps checking cheap.
 * The SDK still validates arguments against `inputSchema` at runtime.
 */
export function defineTool<S extends z.ZodRawShape = Record<never, never>>(
  server: McpServer,
  name: string,
  config: ToolConfig<S>,
  handler: (args: z.infer<z.ZodObject<NoInfer<S>>>) => Promise<CallToolResult>,
): void {
  const register = server.registerTool.bind(server) as unknown as RegisterTool;
  register(name, config, (args) => handler(args as z.infer<z.ZodObject<S>>));
}
