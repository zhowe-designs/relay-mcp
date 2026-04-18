import type { Env } from "./types.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    return new Response("relay-mcp scaffold. Phase 3 wires the MCP handler.", {
      status: 200,
      headers: { "content-type": "text/plain" }
    });
  }
} satisfies ExportedHandler<Env>;
