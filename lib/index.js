// Entry point. Registers the zhmem_* tool family with the Host.
//
// No browser half and no `dsh.client` section: this plugin is a pure tool
// provider. That is deliberate - a browser half would mean the plugin could not
// work until a web UI reloaded, and there is nothing here to render.

export const name = 'zhmem';
export const inject = ['tools'];

import { createTools, ZhmemRuntime } from './tools.js';

/**
 * Locate the Host's `defineTool` helper.
 *
 * Three attempts, in order of preference, because the plugin can be loaded from
 * three different layouts: an installed bundle (bare specifier resolves), the
 * desktop install root, or a profile directory with its own node_modules. A
 * missing helper is not fatal - `defineTool` is a validator/wrapper, and the
 * tool objects are already in its accepted shape, so the raw definition is a
 * working fallback rather than an error the user has to debug.
 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod?.defineTool) return mod.defineTool;
  } catch {
    /* fall through */
  }

  for (const base of [process.env.DSH_INSTALL_ROOT, process.env.DSH_PROFILE_DIR]) {
    if (!base) continue;
    try {
      const url = new URL(`file://${base.replace(/\\/g, '/')}/node_modules/@deepseek-ai/dsh-tools/lib/index.js`);
      const mod = await import(url.href);
      if (mod?.defineTool) return mod.defineTool;
    } catch {
      /* fall through */
    }
  }

  return (definition) => definition;
}

export async function apply(ctx, config = {}) {
  const defineTool = await loadDefineTool();

  const runtime = new ZhmemRuntime({
    dbPath: config.dbPath ?? null,
    offline: config.offline === true,
    ...(config.webThreshold !== undefined ? { webThreshold: config.webThreshold } : {}),
  });

  const tools = createTools(runtime);
  for (const definition of tools) {
    ctx.tools.register(defineTool(definition));
  }

  // Expose the runtime so another plugin (or a test) can reach the same store
  // instead of opening a second writer on the same SQLite file.
  if (typeof ctx.provide === 'function') {
    ctx.provide('zhmem', {
      runtime,
      toolCount: tools.length,
      dbPath: runtime.dbPath,
    });
  }

  // Closing the handle on disposal matters on Windows: a WAL file left open
  // blocks the next process from checkpointing it.
  ctx.on?.('dispose', () => runtime.close());
}

export default { name, inject, apply };
