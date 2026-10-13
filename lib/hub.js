// qoder2api-hub backend supervisor: locate a Python >= 3.9 interpreter, spawn the
// vendored gateway, and expose its OpenAI-compatible surface to the DSH adapter.
//
// Why the version floor: qoder_proxy.py uses str.removeprefix() (Python 3.9+). On an
// older interpreter the auth path raises AttributeError and the socket is dropped,
// which downstream looks like "500 / empty reply" rather than a version problem.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
export const VENDOR_DIR = path.join(PKG_ROOT, 'vendor', 'qoder2api-hub');
export const ENTRY = path.join(VENDOR_DIR, 'qoder_proxy.py');
export const MIN_PY = [3, 9];

function pyVersion(exe) {
  try {
    const out = execFileSync(exe, ['-c', 'import sys;print("%d.%d.%d"%sys.version_info[:3])'], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    }).trim();
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(out);
    return m ? m.slice(1).map(Number) : null;
  } catch { return null; }
}

function versionOk(v) {
  return !!v && (v[0] > MIN_PY[0] || (v[0] === MIN_PY[0] && v[1] >= MIN_PY[1]));
}

function walkForPythons(dir, depth) {
  const out = [];
  const walk = (d, k) => {
    if (k > depth) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isFile() && /^python(\d(\.\d+)?)?\.exe$/i.test(e.name)) out.push(p);
      else if (e.isDirectory()) walk(p, k + 1);
    }
  };
  walk(dir, 0);
  return out;
}

// Probe order matters: managed/uv interpreters and versioned installs first, bare PATH
// names last (on many machines `python` is an old 3.8 that cannot run the gateway).
export function findPython() {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const cands = [];

  if (process.env.DSH_QODER_PYTHON) cands.push(process.env.DSH_QODER_PYTHON);
  cands.push(...walkForPythons(path.join(appdata, 'uv', 'python'), 2));
  for (const root of [path.join(local, 'Programs', 'Python'), 'C:\\Program Files', 'C:\\']) {
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory() && /^Python\s*3(\D|$)/i.test(e.name)) cands.push(path.join(root, e.name, 'python.exe'));
      }
    } catch { /* ignore */ }
  }
  for (const root of [
    path.join(home, 'miniconda3'), path.join(home, 'anaconda3'),
    'C:\\ProgramData\\miniconda3', 'C:\\ProgramData\\anaconda3',
  ]) cands.push(path.join(root, 'python.exe'));
  cands.push('python3', 'python');

  const tried = [];
  for (const c of cands) {
    if (!c) continue;
    if (path.isAbsolute(c) && !fs.existsSync(c)) continue;
    const v = pyVersion(c);
    tried.push({ exe: c, version: v ? v.join('.') : null, ok: versionOk(v) });
    if (versionOk(v)) return { exe: c, version: v.join('.'), tried };
  }
  return { exe: null, version: null, tried };
}

export function pythonHint(tried) {
  const lines = (tried || []).map((t) => `  - ${t.exe} -> ${t.version || 'unusable'}`);
  return [
    `qoder2api-hub needs Python ${MIN_PY.join('.')}+ but none was found.`,
    'Detected interpreters:',
    ...lines,
    'Install Python 3.9+ (https://www.python.org/downloads/, tick "Add python.exe to PATH"),',
    'or point DSH_QODER_PYTHON at a 3.9+ interpreter, e.g.',
    '  set DSH_QODER_PYTHON=C:\\Python312\\python.exe',
  ].join('\n');
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

const JSON_TIMEOUT_MS = 8000;
// Admin calls that reach Qoder upstreams (check-in, credit refresh, task claiming)
// routinely need far more than the read-only default.
const ADMIN_TIMEOUT_MS = 180000;

async function getJson(url, init, timeoutMs = JSON_TIMEOUT_MS) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const t = await r.text();
    let body;
    try { body = JSON.parse(t); } catch { body = t; }
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

// One supervised gateway process. `start()` resolves once /health answers.
export function createHub(opts) {
  const log = opts.log || (() => {});
  const dataDir = opts.dataDir;
  const accountsDir = path.join(dataDir, 'accounts');
  const usageDir = path.join(dataDir, 'usage');

  const state = {
    proc: null,
    port: opts.port || 0,
    apiKey: opts.apiKey || '',
    python: null,
    lastError: null,
    startedAt: null,
    exit: null,
    stdoutTail: [],
    stderrTail: [],
    restarting: false,
  };

  const push = (arr, chunk) => {
    const s = String(chunk);
    for (const line of s.split(/\r?\n/)) {
      if (!line.trim()) continue;
      arr.push(line.slice(0, 400));
      if (arr.length > 60) arr.shift();
    }
  };

  function baseHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (state.apiKey) h.Authorization = `Bearer ${state.apiKey}`;
    return h;
  }

  async function health() {
    if (!state.port) return { status: 0, error: 'not started' };
    return await getJson(`http://127.0.0.1:${state.port}/health`);
  }

  async function waitReady(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (state.proc && state.proc.exitCode !== null) {
        return { ok: false, error: `gateway exited with code ${state.proc.exitCode}` };
      }
      const h = await health();
      if (h.status === 200 && h.body?.ok) return { ok: true, health: h.body };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, error: `gateway did not become ready within ${timeoutMs}ms` };
  }

  async function start() {
    if (state.proc && state.proc.exitCode === null) return { ok: true, reused: true };

    if (!fs.existsSync(ENTRY)) {
      state.lastError = `vendored gateway missing: ${ENTRY}`;
      return { ok: false, error: state.lastError };
    }

    const py = findPython();
    if (!py.exe) {
      state.lastError = 'no Python 3.9+ interpreter found';
      return { ok: false, error: state.lastError, hint: pythonHint(py.tried), tried: py.tried };
    }
    state.python = py;

    if (!state.port) state.port = await freePort();
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.mkdirSync(usageDir, { recursive: true });

    const args = [
      ENTRY,
      '--port', String(state.port),
      '--accounts-dir', accountsDir,
      '--usage-dir', usageDir,
    ];
    if (state.apiKey) args.push('--api-key', state.apiKey);

    // The gateway talks to Qoder upstreams; a proxying env can break the handshake.
    const env = { ...process.env };
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      delete env[k];
    }
    env.NO_PROXY = '127.0.0.1,localhost';
    env.no_proxy = '127.0.0.1,localhost';
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUNBUFFERED = '1';

    state.exit = null;
    state.stderrTail = [];
    state.stdoutTail = [];

    const proc = spawn(py.exe, args, {
      cwd: VENDOR_DIR,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.proc = proc;
    state.startedAt = Date.now();

    proc.stdout?.on('data', (c) => push(state.stdoutTail, c));
    proc.stderr?.on('data', (c) => push(state.stderrTail, c));
    proc.on('exit', (code, signal) => {
      state.exit = { code, signal, at: Date.now() };
      log(`gateway exited code=${code} signal=${signal}`);
      if (!state.restarting && state.proc === proc) state.proc = null;
    });
    proc.on('error', (e) => {
      state.lastError = e.message;
      log(`gateway spawn error: ${e.message}`);
    });

    const ready = await waitReady();
    if (!ready.ok) {
      state.lastError = ready.error;
      log(`gateway not ready: ${ready.error} :: ${state.stderrTail.slice(-4).join(' | ')}`);
      return { ok: false, error: ready.error, stderr: state.stderrTail.slice(-12), python: py.exe };
    }
    state.lastError = null;
    log(`gateway ready on 127.0.0.1:${state.port} (python ${py.version})`);
    return { ok: true, port: state.port, python: py.exe, health: ready.health };
  }

  async function stop() {
    const proc = state.proc;
    if (!proc) return;
    state.restarting = true;
    try { proc.kill(); } catch { /* ignore */ }
    const deadline = Date.now() + 6000;
    while (proc.exitCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (proc.exitCode === null) {
      try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ }
    }
    if (state.proc === proc) state.proc = null;
    state.restarting = false;
  }

  async function restart() {
    await stop();
    state.port = 0;
    panelToken = '';
    return await start();
  }

  // Every /accounts|/tasks|/scheduler|/settings|/logs|/diag|/update route is
  // panel-guarded: without a session token the gateway answers 401 before it ever
  // looks at the request. Sign in lazily, cache the token, and retry once on 401 so
  // the caller never has to know the panel password exists.
  let panelToken = '';

  async function panelLogin() {
    const r = await getJson(`http://127.0.0.1:${state.port}/panel/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: opts.panelPassword || 'admin' }),
    });
    if (r.status === 200 && r.body && r.body.token) {
      panelToken = String(r.body.token);
      return panelToken;
    }
    return '';
  }

  async function panelCall(pathname, { method = 'GET', body, timeoutMs = ADMIN_TIMEOUT_MS } = {}) {
    if (!panelToken) await panelLogin();
    const once = async () => await getJson(`http://127.0.0.1:${state.port}${pathname}`, {
      method,
      headers: panelToken
        ? { 'Content-Type': 'application/json', 'X-Panel-Token': panelToken }
        : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, timeoutMs);
    let r = await once();
    if (r.status === 401) {
      panelToken = '';
      if (await panelLogin()) r = await once();
    }
    return r;
  }

  return {
    state,
    accountsDir,
    usageDir,
    start,
    stop,
    restart,
    health,
    get port() { return state.port; },
    get baseUrl() { return state.port ? `http://127.0.0.1:${state.port}/v1` : ''; },
    get running() { return !!(state.proc && state.proc.exitCode === null); },

    // ---- gateway admin surface (panel session is handled internally) ----

    async login(password) {
      if (password !== undefined) opts.panelPassword = password;
      const token = await panelLogin();
      return token
        ? { status: 200, body: { ok: true, token } }
        : { status: 401, body: { error: 'panel login failed' } };
    },

    async panel(pathname, arg) {
      if (arg && (arg.token || arg.method || arg.body)) {
        const { token, method = 'GET', body } = arg;
        const h = { 'Content-Type': 'application/json' };
        if (token) h['X-Panel-Token'] = token;
        return await getJson(`http://127.0.0.1:${state.port}${pathname}`, {
          method,
          headers: h,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      }
      return await panelCall(pathname);
    },

    async models() {
      return await getJson(`http://127.0.0.1:${state.port}/v1/models`, { headers: baseHeaders() });
    },

    async creditsSummary() {
      // /credits/summary is API-key scoped and read-only by design.
      return await getJson(`http://127.0.0.1:${state.port}/credits/summary`, { headers: baseHeaders() });
    },

    async scanDesktop() {
      return await panelCall('/accounts/import/desktop', { method: 'POST', body: {} });
    },

    async importDesktopAll() {
      return await panelCall('/accounts/import/desktop', { method: 'POST', body: { all: true } });
    },

    async accounts() {
      return await panelCall('/accounts');
    },

    // Runs the daily check-in for every pooled account. Each upstream round trip can
    // take a while, hence the generous timeout.
    async checkin() {
      return await panelCall('/accounts/checkin', { method: 'POST', body: {}, timeoutMs: 300000 });
    },

    async credits() {
      return await panelCall('/credits/summary');
    },

    async scheduler() {
      return await panelCall('/scheduler');
    },

    async tasks() {
      return await panelCall('/tasks');
    },

    async tasksRun(taskId) {
      return await panelCall('/tasks/run', {
        method: 'POST',
        body: taskId ? { id: taskId } : {},
        timeoutMs: 300000,
      });
    },

    async usage() {
      return await panelCall('/usage');
    },

    async settings() {
      return await panelCall('/settings');
    },
  };
}

export async function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await getJson(`http://127.0.0.1:${port}/health`);
    if (h.status === 200) return h;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}
