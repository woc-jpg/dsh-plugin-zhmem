// Standalone MCP stdio server.
//
// The plugin path is the one users take, but a stdio server is still the way to
// reach a client that speaks MCP and not the DSH plugin protocol (WorkBuddy,
// Claude Desktop, anything else). Same tools, same database, no second
// implementation - `createTools` is the single definition of the surface, and
// this file only translates it into MCP's registration calls.

import { pathToFileURL } from 'node:url';

import { createTools, ZhmemRuntime } from './tools.js';

/** Minimal JSON-RPC over stdio: enough for tools/list and tools/call. */
export function createServer({ runtime = new ZhmemRuntime() } = {}) {
  const tools = new Map(createTools(runtime).map((t) => [t.name, t]));

  async function handle(message) {
    const { id, method, params } = message ?? {};

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'zhmem', version: '0.2.0' },
        },
      };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [...tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: toJsonSchema(t.parameters ?? {}),
          })),
        },
      };
    }

    if (method === 'tools/call') {
      const name = params?.name;
      const tool = tools.get(name);
      if (!tool) {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${name}` } };
      }
      try {
        const value = await tool.execute(params?.arguments ?? {});
        const rendered = tool.output?.render?.(params?.arguments ?? {}, value) ?? [{ type: 'text', text: String(value) }];
        return { jsonrpc: '2.0', id, result: { content: rendered } };
      } catch (err) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `错误：${err.message}` }], isError: true } };
      }
    }

    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

    if (id === undefined) return null; // notification
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } };
  }

  return { handle, runtime, tools };
}

/** Convert the compact parameter spec into JSON Schema. */
export function toJsonSchema(parameters) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(parameters)) {
    const prop = { type: spec.type ?? 'string' };
    if (spec.description) prop.description = spec.description;
    if (spec.items) prop.items = spec.items;
    if (spec.enum) prop.enum = spec.enum;
    properties[key] = prop;
    if (spec.required) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

/** Line-delimited JSON transport (one JSON object per line). */
export async function main() {
  const { handle } = createServer();
  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        try {
          const reply = await handle(JSON.parse(line));
          if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
        } catch (err) {
          process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: err.message } })}\n`);
        }
      }
      nl = buffer.indexOf('\n');
    }
  });
}

// Run when executed directly (`node lib/mcp.js`), stay silent when imported.
// Without this the process reads stdin forever and answers nothing - the failure
// mode looks like a hung server, not a missing entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export default createServer;
