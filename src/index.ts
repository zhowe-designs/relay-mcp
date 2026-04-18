import { z } from "zod";
import type { Env } from "./types.js";
import { makeClient } from "./db.js";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  handleRegister,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleToken,
  validateBearer,
  corsPreflight
} from "./oauth.js";
import {
  listThreads,
  listThreadsSchema,
  createThread,
  createThreadSchema,
  archiveThread,
  archiveThreadSchema
} from "./tools/threads.js";
import {
  postMessage,
  postMessageSchema,
  readThread,
  readThreadSchema,
  checkNew,
  checkNewSchema
} from "./tools/messages.js";

const SERVER_INFO = { name: "relay-mcp", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

// Tool registry. One entry per MCP tool the server exposes.
// description is what the client shows to the model, so keep it tight.
const TOOLS = [
  {
    name: "relay_list_threads",
    description:
      "List active relay threads with recent-activity timestamp and message count. Pass include_archived to see archived threads too.",
    inputSchema: zodToJsonSchema(listThreadsSchema),
    schema: listThreadsSchema,
    handler: listThreads
  },
  {
    name: "relay_create_thread",
    description:
      "Create a new relay thread with a stable name. Names are unique per user. Use post_message if you want implicit creation.",
    inputSchema: zodToJsonSchema(createThreadSchema),
    schema: createThreadSchema,
    handler: createThread
  },
  {
    name: "relay_post_message",
    description:
      "Post a message to a thread. Creates the thread if it does not exist. Required: thread_name, content, surface (chat, cowork, code, or other).",
    inputSchema: zodToJsonSchema(postMessageSchema),
    schema: postMessageSchema,
    handler: postMessage
  },
  {
    name: "relay_read_thread",
    description:
      "Read recent messages from a thread, newest first. Pass reader_tag to advance a per-reader cursor so check_new can later return only new messages.",
    inputSchema: zodToJsonSchema(readThreadSchema),
    schema: readThreadSchema,
    handler: readThread
  },
  {
    name: "relay_check_new",
    description:
      "Return only messages posted since this reader_tag last read the thread. Advances the cursor. Use this to poll for new activity.",
    inputSchema: zodToJsonSchema(checkNewSchema),
    schema: checkNewSchema,
    handler: checkNew
  },
  {
    name: "relay_archive_thread",
    description: "Soft-archive a thread so it no longer appears in default list_threads output.",
    inputSchema: zodToJsonSchema(archiveThreadSchema),
    schema: archiveThreadSchema,
    handler: archiveThread
  }
] as const;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return corsPreflight();

    if (url.pathname === "/health") {
      return json({ ok: true, service: SERVER_INFO.name, version: SERVER_INFO.version });
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return authorizationServerMetadata(request);
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return protectedResourceMetadata(request);
    }
    if (url.pathname === "/register") return handleRegister(request);
    if (url.pathname === "/authorize") {
      if (request.method === "GET") return handleAuthorizeGet(request);
      if (request.method === "POST") return handleAuthorizePost(request, env);
      return new Response("method not allowed", { status: 405 });
    }
    if (url.pathname === "/token") return handleToken(request, env);

    // MCP endpoint. POST accepts JSON-RPC. GET returns a short hello.
    if (url.pathname === "/mcp" || url.pathname === "/") {
      if (request.method === "GET") {
        return json({
          service: SERVER_INFO.name,
          protocol: PROTOCOL_VERSION,
          usage: "POST JSON-RPC 2.0 requests to this endpoint with Authorization: Bearer <token>."
        });
      }
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }

      const authResult = await validateBearer(request, env);
      if (!authResult.ok) {
        const origin = `${url.protocol}//${url.host}`;
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
          }
        });
      }

      let body: JsonRpcRequest | JsonRpcRequest[];
      try {
        body = (await request.json()) as JsonRpcRequest | JsonRpcRequest[];
      } catch {
        return json(rpcError(null, -32700, "Parse error"));
      }

      const requests = Array.isArray(body) ? body : [body];
      const responses: JsonRpcResponse[] = [];
      for (const req of requests) {
        const res = await handleRpc(req, env, authResult.userId);
        if (res) responses.push(res);
      }
      if (responses.length === 0) return new Response(null, { status: 204 });
      const payload = Array.isArray(body) ? responses : responses[0];
      return json(payload);
    }

    return new Response("not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;

async function handleRpc(
  req: JsonRpcRequest,
  env: Env,
  userId: string
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const isNotification = req.id === undefined;

  try {
    switch (req.method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO
        });

      case "notifications/initialized":
      case "notifications/cancelled":
        return null;

      case "ping":
        return rpcResult(id, {});

      case "tools/list":
        return rpcResult(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
          }))
        });

      case "tools/call":
        return await handleToolCall(id, req.params ?? {}, env, userId);

      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `method not found: ${req.method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isNotification) return null;
    return rpcError(id, -32603, message);
  }
}

async function handleToolCall(
  id: number | string | null,
  params: Record<string, unknown>,
  env: Env,
  userId: string
): Promise<JsonRpcResponse> {
  const name = params.name as string | undefined;
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);

  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    return rpcError(id, -32602, `invalid arguments: ${parsed.error.message}`);
  }

  const db = makeClient(env);
  try {
    const result = await (tool.handler as (
      c: ReturnType<typeof makeClient>,
      u: string,
      p: unknown
    ) => Promise<unknown>)(db, userId, parsed.data);

    return rpcResult(id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // MCP convention: tool errors come back in result with isError true so the
    // model can read them, rather than as JSON-RPC errors.
    return rpcResult(id, {
      content: [{ type: "text", text: message }],
      isError: true
    });
  }
}

function rpcResult(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// Minimal zod-to-json-schema bridge. We only need enough to populate the
// inputSchema field in tools/list output. Covers objects, strings, numbers,
// booleans, enums, records, and optional fields, which is all v1 needs.
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodNodeToJsonSchema(schema);
}

function zodNodeToJsonSchema(node: z.ZodTypeAny): Record<string, unknown> {
  if (node instanceof z.ZodObject) {
    const shape = node.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(shape)) {
      const { schema: childSchema, optional } = unwrap(child);
      properties[key] = zodNodeToJsonSchema(childSchema);
      if (!optional) required.push(key);
    }
    const out: Record<string, unknown> = { type: "object", properties };
    if (required.length) out.required = required;
    return out;
  }
  if (node instanceof z.ZodString) return { type: "string" };
  if (node instanceof z.ZodNumber) return { type: "number" };
  if (node instanceof z.ZodBoolean) return { type: "boolean" };
  if (node instanceof z.ZodEnum) return { type: "string", enum: node.options };
  if (node instanceof z.ZodRecord) return { type: "object", additionalProperties: true };
  if (node instanceof z.ZodArray)
    return { type: "array", items: zodNodeToJsonSchema(node.element as z.ZodTypeAny) };
  return {};
}

function unwrap(node: z.ZodTypeAny): { schema: z.ZodTypeAny; optional: boolean } {
  let current = node;
  let optional = false;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodNullable
  ) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) optional = true;
    current = (current as z.ZodOptional<z.ZodTypeAny>)._def.innerType;
  }
  return { schema: current, optional };
}
