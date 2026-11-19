// Tiny KEY=VALUE reader for a `zhmem.env` file sitting next to the launcher.
//
// Why a file instead of just documenting `set ZHMEM_DB=...`: the people who
// need to move the database are the ones least likely to set an environment
// variable before every double-click. A file travels with the folder, survives
// reboots, and is obvious to edit.
//
// Real environment variables always win - a shell that sets ZHMEM_DB is an
// explicit, current instruction and should not be silently overridden by a
// stale file.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ENV_FILE = 'zhmem.env';

export function loadEnvFile(root, { silent = false } = {}) {
  const file = join(root, ENV_FILE);
  if (!existsSync(file)) return { applied: [], file };

  const applied = [];
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    applied.push({ key, value });
  }

  if (!silent && applied.length) {
    for (const { key, value } of applied) console.log(`配置：${key}=${value}`);
  }
  return { applied, file };
}
