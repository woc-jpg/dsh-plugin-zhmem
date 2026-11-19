// Launcher for the standalone build.
//
// Same rhythm as LibreTV's: start the service, wait until it answers, open a
// dedicated browser window pointed at it, and die when that window closes. The
// point of the dedicated profile is that closing it does not touch the user's
// normal browsing session, and killing the launcher does not leave a stray
// server behind.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { loadEnvFile } from './lib/config.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Must run before anything reads ZHMEM_DB / PORT.
loadEnvFile(ROOT);

const PORT = Number(process.env.PORT ?? 8570);
const OFFLINE = process.env.ZHMEM_OFFLINE === '1';
const PROFILE = join(ROOT, '.browser-profile');
const HEALTH = `http://127.0.0.1:${PORT}/api/status`;

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  if (process.env.ZHMEM_BROWSER) return process.env.ZHMEM_BROWSER;
  return BROWSERS.find((p) => existsSync(p)) ?? null;
}

// The window opens the size a normal desktop app opens: comfortable, not
// filling the screen. Maximizing is left to the user and behaves normally,
// because we never pass --start-maximized and never pin the size to the work
// area. On a fresh profile the browser takes these numbers verbatim; after that
// the profile's own remembered geometry wins, which is what you want once
// someone has resized it.
const DEFAULT_WINDOW = { width: 1296, height: 828 };

function screenArea() {
  try {
    const raw = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms;' +
        '$a=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea;' +
        '"$($a.X),$($a.Y),$($a.Width),$($a.Height)"'],
      { encoding: 'utf8', timeout: 4000, windowsHide: true },
    ).trim();
    const [x, y, width, height] = raw.split(',').map(Number);
    if ([x, y, width, height].every((n) => Number.isFinite(n)) && width > 400) {
      return { x, y, width, height };
    }
  } catch {
    // no PowerShell, or no WinForms: fall back to a plain centred window
  }
  return null;
}

function windowRect(area) {
  const custom = process.env.ZHMEM_WINDOW;
  let width = DEFAULT_WINDOW.width;
  let height = DEFAULT_WINDOW.height;
  if (custom && /^\d+x\d+$/.test(custom)) {
    [width, height] = custom.split('x').map(Number);
  }
  if (!area) return { width, height, x: 60, y: 60 };
  // Never open bigger than the work area on a small screen.
  width = Math.min(width, area.width - 40);
  height = Math.min(height, area.height - 40);
  return {
    width,
    height,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
  };
}

async function waitForServer(deadlineMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      const res = await fetch(HEALTH);
      if (res.ok) {
        const data = await res.json();
        return data;
      }
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  return null;
}

function stop(proc, signal = 'SIGTERM') {
  if (!proc || proc.exitCode !== null) return;
  try { proc.kill(signal); } catch { /* already gone */ }
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('[错误] 没有找到 Edge 或 Chrome。');
    console.error('你可以自己装一个，或者用 ZHMEM_BROWSER 环境变量指定浏览器路径。');
    process.exitCode = 1;
    return;
  }

  console.log(`启动服务（端口 ${PORT}）…`);
  const server = spawn(process.execPath, [join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ...(OFFLINE ? { ZHMEM_OFFLINE: '1' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  server.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[错误] 服务异常退出（code ${code}）。`);
      if (serverLog.trim()) console.error(serverLog.trim());
    }
  });

  const status = await waitForServer();
  if (!status) {
    console.error('[错误] 服务在 30 秒内没有响应。');
    if (serverLog.trim()) console.error(serverLog.trim());
    stop(server, 'SIGKILL');
    process.exitCode = 1;
    return;
  }

  const counts = status.counts ?? {};
  console.log(`服务就绪：知识库 ${Object.values(counts).reduce((a, b) => a + b, 0)} 条，版本 ${status.version}`);
  const rect = windowRect(screenArea());
  console.log(`打开窗口 ${rect.width}×${rect.height}…（关掉窗口程序就退出）`);

  const args = [
    `--user-data-dir=${PROFILE}`,
    `--app=http://127.0.0.1:${PORT}/`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-features=Translate,MediaRouter',
    `--window-size=${rect.width},${rect.height}`,
    `--window-position=${rect.x},${rect.y}`,
  ];

  const child = spawn(browser, args, { stdio: 'ignore', windowsHide: false });

  // Poll instead of listening for 'exit': when the user closes the last app
  // window, the browser process sometimes lingers for a moment, and sometimes
  // hands off to an existing instance. Checking liveness directly is the only
  // signal that reliably reflects "the window is gone".
  let running = true;
  const watchdog = setInterval(() => {
    if (!running) return;
    try {
      process.kill(child.pid, 0);
    } catch {
      running = false;
      clearInterval(watchdog);
      stop(server);
      console.log('窗口已关闭，服务停止。');
      process.exit(0);
    }
  }, 2000);

  const shutdown = () => {
    running = false;
    clearInterval(watchdog);
    stop(child, 'SIGKILL');
    stop(server);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`[错误] ${error.message}`);
  process.exitCode = 1;
});
