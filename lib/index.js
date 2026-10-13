// dsh-qoder2api-hub — DSH plugin that runs the vendored qoder2api-hub gateway and
// exposes its models as a DSH LLM provider.
//
// Division of labour:
//   vendor/qoder2api-hub  owns every Qoder protocol detail (COSY signing, credential
//                         decryption, catalog parsing, scheduling, check-in).
//   this file             owns DSH integration: supervise the Python process, proxy its
//                         OpenAI surface behind a loopback shim, register an llm adapter,
//                         and serve the status routes the client card consumes.
//
// Requests are forwarded verbatim. In particular a model's thinking-depth parameter
// (reasoning_effort / reasoning) is passed through untouched.
//
// Iron rule: exceptions must never crash the plugin loader — one throw here stops the
// whole DSH from opening.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import z from '@deepseek-ai/schemastery';

import { createHub, findPython, pythonHint, MIN_PY } from './hub.js';

export const name = 'qoder2api-hub';

// 'llm' is required: apply() calls ctx.llm.registerAdapter() to publish the qoder
// provider group. Declaring it here is what makes Cordis populate ctx.llm at all;
// without it ctx.llm is undefined and registration silently fails.
// 'webServer' and 'settings' stay optional: apply() reaches them through
// ctx.inject([...]) so the plugin still loads when either is absent.
export const inject = ['llm'];

// ---------- constants ----------

const SETTINGS_NS = 'qoder2api-hub';
const SECTION_SCHEMA = z.object({});
const PROVIDER_ID = 'qoder';
const PROVIDER_LABEL = 'Qoder (qoder2api-hub)';

const DEFAULTS = {
  enabled: true,
  port: 0,              // 0 = pick a free port
  apiKey: '',           // empty = gateway runs in no-key local mode
  panelPassword: 'admin',
  claimHour: 9,         // local hour for the daily check-in sweep
  quotaPollMs: 180000,
  statusPollMs: 20000,
  autoImport: true,     // import local Qoder client credentials on first start
};

const REQUEST_BODY_LIMIT = 67108864;

function envInt(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function dataDirOf() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'qoder2api-hub');
}

// ---------- small http helpers ----------

function hostnameOfHost(host) {
  if (!host) return '';
  if (host.startsWith('[') && host.includes(']')) return host.slice(1, host.indexOf(']'));
  const at = host.lastIndexOf(':');
  if (at > 0 && !host.includes(']') && host.indexOf(':') === at) return host.slice(0, at);
  return host;
}

function hostIsLoopback(host) {
  const h = hostnameOfHost(String(host || ''));
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function originIsLoopback(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return hostIsLoopback(u.host);
  } catch { return false; }
}

function writeJson(res, status, body) {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    });
    res.end(text);
  } catch { /* ignore */ }
}

function openaiError(status, message, type = 'upstream_error', code) {
  return { error: { message, type, code: code ?? status } };
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

// ---------- model catalog mapping ----------

// The gateway advertises rich metadata; pi-ai needs a narrower shape. Nothing is invented:
// a field absent upstream stays absent here.
function reasoningFields(m) {
  // Prefer explicit thinking-level tiers from the gateway's catalog.
  const tiers = Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts
    : Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts
      : null;
  const isReasoning = m.is_reasoning === true || !!tiers?.length || m.capabilities?.reasoning === true;
  if (!isReasoning) return { reasoning: false };

  const efforts = (tiers || []).map((t) => String(t)).filter(Boolean);
  if (!efforts.length) return { reasoning: true };

  // pi-ai resolves params.reasoning_effort through model.thinkingLevelMap before sending it
  // upstream, so an identity map keeps the client's chosen tier byte-for-byte.
  const map = {};
  for (const e of efforts) map[e] = e;
  return { reasoning: true, thinkingLevelMap: map, reasoningEfforts: efforts };
}

function toPiModel(m, baseUrl, providerId) {
  const pricing = m.pricing || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const ctx = num(m.context_window ?? m.contextWindow ?? m.context_length ?? 200000) || 200000;
  const maxOut = num(m.max_output_tokens ?? m.maxOutputTokens ?? m.max_tokens) || 32768;
  return {
    id: m.id,
    name: m.display_name || m.name || m.id,
    provider: providerId,
    baseUrl,
    api: 'openai-completions',
    contextWindow: ctx,
    maxTokens: Math.min(maxOut, ctx),
    input: Array.isArray(m.input) && m.input.length ? m.input : ['text'],
    cost: {
      input: num(pricing.input ?? pricing.prompt),
      output: num(pricing.output ?? pricing.completion),
      cacheRead: num(pricing.cache_read ?? pricing.cached),
      cacheWrite: num(pricing.cache_write),
    },
    ...reasoningFields(m),
  };
}

function normalizeTools(tools) {
  // DSH hands adapters flat descriptors; the OpenAI wire format wraps them in `function`.
  // Sending the flat shape gets rejected upstream, so wrap only when needed.
  if (!Array.isArray(tools) || !tools.length) return tools;
  return tools.map((t) => {
    if (t && typeof t === 'object' && t.type === 'function' && t.function) return t;
    if (t && typeof t === 'object' && t.name && t.parameters) {
      return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
    }
    return t;
  });
}

// ---------- loopback shim ----------
// A private, token-guarded reverse proxy in front of the gateway. DSH's adapter talks to
// this, so the gateway port is never exposed on a public interface and every request body
// passes through unchanged.

function createShim(hub, log) {
  const token = `sk-qhub-${randomBytes(24).toString('base64url')}`;
  let server = null;
  let port = 0;

  async function forward(req, res, rawBody) {
    const target = `http://127.0.0.1:${hub.port}${req.url}`;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.authorization;      // the gateway owns its own auth
    delete headers['content-length'];
    delete headers.connection;
    if (hub.state.apiKey) headers.authorization = `Bearer ${hub.state.apiKey}`;

    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    let upstream;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : rawBody,
        signal: abort.signal,
        duplex: 'half',
      });
    } catch (e) {
      if (e.name === 'AbortError') return;
      log(`forward failed: ${e.message}`);
      return writeJson(res, 502, openaiError(502, `qoder2api-hub unreachable: ${e.message}`));
    }

    const outHeaders = {};
    for (const [k, v] of upstream.headers.entries()) {
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) continue;
      outHeaders[k] = v;
    }
    res.writeHead(upstream.status, outHeaders);

    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    res.on('close', () => { try { reader.cancel(); } catch { /* ignore */ } });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) res.write(Buffer.from(value));
      }
    } catch (e) {
      if (e.name !== 'AbortError') log(`stream aborted: ${e.message}`);
    }
    try { res.end(); } catch { /* ignore */ }
  }

  async function handler(req, res) {
    try {
      if (!hostIsLoopback(req.headers.host)) return writeJson(res, 403, { error: 'forbidden host' });
      if (!originIsLoopback(req.headers.origin)) return writeJson(res, 403, { error: 'forbidden origin' });
      const auth = String(req.headers.authorization || '');
      const expected = `Bearer ${token}`;
      if (auth !== expected) return writeJson(res, 401, openaiError(401, 'invalid api key', 'authentication_error'));

      const urlPath = (req.url || '/').split('?')[0];
      if (req.method === 'GET' && urlPath === '/healthz') {
        return writeJson(res, 200, { ok: true, hub: hub.running, port: hub.port });
      }

      let rawBody = Buffer.alloc(0);
      if (!['GET', 'HEAD'].includes(req.method)) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > REQUEST_BODY_LIMIT) return writeJson(res, 413, openaiError(413, 'payload too large'));
          chunks.push(chunk);
        }
        rawBody = Buffer.concat(chunks);
      }

      // Rewrite the tool shape only for chat/responses payloads; everything else is opaque.
      if (rawBody.length && /^\/v1\/(chat\/completions|responses)/.test(urlPath)) {
        try {
          const parsed = JSON.parse(rawBody.toString('utf8'));
          if (parsed && Array.isArray(parsed.tools)) {
            parsed.tools = normalizeTools(parsed.tools);
            rawBody = Buffer.from(JSON.stringify(parsed), 'utf8');
          }
        } catch { /* pass through verbatim */ }
      }

      return await forward(req, res, rawBody);
    } catch (e) {
      log(`shim error: ${e.message}`);
      try { writeJson(res, 502, openaiError(502, `shim error: ${e.message}`)); } catch { /* ignore */ }
    }
  }

  return {
    token,
    get port() { return port; },
    get baseUrl() { return `http://127.0.0.1:${port}/v1`; },
    ready: new Promise((resolve, reject) => {
      server = http.createServer((req, res) => { handler(req, res).catch(() => { /* swallow */ }); });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
    }),
    close() { try { server?.close(); } catch { /* ignore */ } },
  };
}

// ---------- pi-ai adapter ----------

// Inert credential seam: this provider authenticates only through the shim token, so the
// pi-ai credential lifecycle must stay untouched.
const INERT_AUTH = {
  credentials: {
    async read() { return undefined; },
    async list() { return []; },
    async modify() { throw new Error('dsh-qoder2api-hub: this route has no pi-ai credential lifecycle'); },
    async delete() { return undefined; },
  },
  authContext: {
    async env() { return undefined; },
    async fileExists() { return false; },
  },
};

const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
};

function createHubAdapter({ shim, modelsRef, log }) {
  const baseUrl = shim.baseUrl;
  const buildModels = () => (modelsRef.list || []).map((m) => toPiModel(m, baseUrl, PROVIDER_ID));

  const provider = {
    ...createProvider({
      id: PROVIDER_ID,
      name: PROVIDER_LABEL,
      auth: {
        apiKey: {
          name: 'qoder2api-hub token',
          async resolve({ credential }) {
            const apiKey = credential?.key || shim.token;
            return { auth: { apiKey }, source: 'qoder2api-hub' };
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };

  const profile = {
    provider: PROVIDER_ID,
    displayName: PROVIDER_LABEL,
    // Reasoning models emit thinking tokens before content; a generous idle window keeps
    // long silent stretches from being read as a dead stream.
    streamIdleTimeoutMs: 600000,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-qoder2api-hub retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };

  const profiles = new Map([[PROVIDER_ID, profile]]);

  return new HubPiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => shim.token,
  });
}

class HubPiAiAdapter extends PiAiAdapter {}

// ---------- plugin body ----------

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const dataDir = dataDirOf();
  const log = (msg) => {
    try { ctx.logger?.info?.(`[qoder2api-hub] ${msg}`); } catch { /* ignore */ }
    try { console.log(`[qoder2api-hub] ${msg}`); } catch { /* ignore */ }
  };

  const modelsRef = { list: [], fetchedAt: 0, error: null, source: null };
  const status = {
    startedAt: Date.now(),
    lastCheckin: null,
    lastCheckinAttempt: null,
    lastQuota: null,
    accounts: null,
    inventory: null,
    lastError: null,
  };

  const hub = createHub({
    dataDir,
    port: envInt(process.env.DSH_QODER_PORT, cfg.port),
    apiKey: cfg.apiKey || '',
    panelPassword: cfg.panelPassword,
    log,
  });

  let shim = null;
  let releaseAdapter = null;
  const timers = [];
  let stopped = false;

  const guard = (label, fn) => {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') r.catch((e) => log(`${label} async error: ${e.message}`));
    } catch (e) {
      log(`${label} error: ${e.message}`);
    }
  };

  async function refreshModels() {
    try {
      const r = await hub.models();
      const list = Array.isArray(r.body?.data) ? r.body.data : [];
      if (list.length) {
        modelsRef.list = list;
        modelsRef.fetchedAt = Date.now();
        modelsRef.error = null;
        modelsRef.source = 'gateway';
        return list.length;
      }
      modelsRef.error = r.body?.error?.message || `no models (status ${r.status})`;
    } catch (e) {
      modelsRef.error = e.message;
    }
    return 0;
  }

  // The shim token is the credential every in-harness call authenticates with.
  // The status route is reachable from the browser, so it reports that a token
  // exists and never the token itself.
  function shimTokenState() {
    return { present: !!shim?.token, masked: shim?.token ? `sk-qhub-****${String(shim.token).slice(-4)}` : null };
  }

  async function refreshStatus() {    try {
      const h = await hub.health();
      if (h.status !== 200) {
        status.lastError = h.error || `health status ${h.status}`;
        return;
      }
      status.lastError = null;
      const body = h.body || {};
      status.accounts = { total: body.accounts ?? null, ready: body.accounts_ready ?? null, realm: body.realm ?? null };

      // The hub signs in to the gateway's panel on its own; only the account inventory
      // needs the session token it keeps internally.
      const inv = await hub.accounts();
      if (Array.isArray(inv.body?.accounts)) status.inventory = inv.body.accounts;
      const credits = await hub.credits();
      if (credits.status === 200 && credits.body) status.lastQuota = { at: Date.now(), ...credits.body };
      const sched = await hub.scheduler();
      if (sched.status === 200 && sched.body) status.scheduler = sched.body;
    } catch (e) {
      status.lastError = e.message;
    }
  }

  async function runCheckin(manual = false) {
    status.lastCheckinAttempt = Date.now();
    try {
      const r = await hub.checkin();
      status.lastCheckin = { at: Date.now(), status: r.status, ...(r.body || {}) };
      if (r.status !== 200) log(`check-in returned ${r.status}${r.error ? ` (${r.error})` : ''}`);
      return status.lastCheckin;
    } catch (e) {
      status.lastCheckin = { at: Date.now(), error: e.message };
      if (manual) log(`check-in error: ${e.message}`);
      return status.lastCheckin;
    }
  }

  async function bootstrapImport() {
    if (!cfg.autoImport) return;
    try {
      const scan = await hub.scanDesktop();
      const detected = scan.body?.detected || [];
      if (detected.length) log(`detected ${detected.length} local Qoder credential(s)`);
      const r = await hub.importDesktopAll();
      const n = Array.isArray(r.body?.imported) ? r.body.imported.length : 0;
      if (n) log(`imported ${n} local Qoder account(s)`);
    } catch (e) {
      log(`local credential import skipped: ${e.message}`);
    }
  }

  async function startAdapter() {
    const res = await hub.start();
    if (!res.ok) {
      status.lastError = res.error;
      log(`backend start failed: ${res.error}${res.hint ? `\n${res.hint}` : ''}`);
      return false;
    }

    await bootstrapImport();
    await refreshModels();
    log(`model catalog: ${modelsRef.list.length} entr${modelsRef.list.length === 1 ? 'y' : 'ies'}`);

    shim = createShim(hub, log);
    await shim.ready;

    const adapter = createHubAdapter({ shim, modelsRef, log });
    try {
      releaseAdapter = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
    } catch (e) {
      log(`registerAdapter failed: ${e.message}`);
      shim.close();
      return false;
    }
    ctx.effect(() => () => {
      try { releaseAdapter?.(); } catch { /* ignore */ }
      shim.close();
    });
    try { ctx.emit('llm/adapters-updated'); } catch { /* ignore */ }
    log(`adapter registered (shim 127.0.0.1:${shim.port} -> hub 127.0.0.1:${hub.port}, models=${modelsRef.list.length})`);
    return true;
  }

  // ---------- client-facing status routes ----------

  function mountRoutes() {
    guard('webServer', () => {
      ctx.inject(['webServer'], (webCtx) => {
        const register = (opts) => (typeof webCtx.webServer?.register === 'function'
          ? webCtx.webServer.register(opts)
          : typeof webCtx.register === 'function' ? webCtx.register(opts) : null);
        if (typeof webCtx.webServer?.register !== 'function' && typeof webCtx.register !== 'function') {
          log('webServer.register unavailable; status routes skipped');
          return;
        }
        const basePath = '/plugins/dsh-qoder2api-hub';

        async function statusHandler(req, res) {
          try {
            if (!hostIsLoopback(req.headers.host)) return writeJson(res, 403, { error: 'forbidden' });
            const sub = ((req.url || '/').split('?')[0]).slice(basePath.length) || '/status';
            const method = (req.method || 'GET').toUpperCase();

            if (method === 'GET' && (sub === '/status' || sub === '/')) {
              return writeJson(res, 200, {
                ok: true,
                plugin: name,
                provider: PROVIDER_ID,
                running: hub.running,
                backend: {
                  port: hub.port, up: hub.running, startedAt: hub.state.startedAt,
                  python: hub.state.python?.exe || null, pythonVersion: hub.state.python?.version || null,
                  minPython: MIN_PY.join('.'),
                  lastError: hub.state.lastError,
                  stderrTail: hub.state.stderrTail.slice(-8),
                  exit: hub.state.exit,
                  dataDir,
                },
                shim: { port: shim?.port || 0, active: !!shim },
                adapter: { id: PROVIDER_ID, active: !!releaseAdapter },
                models: {
                  count: modelsRef.list.length,
                  fetchedAt: modelsRef.fetchedAt,
                  source: modelsRef.source,
                  error: modelsRef.error,
                  list: modelsRef.list.map((m) => ({
                    id: m.id,
                    name: m.display_name || m.name || m.id,
                    contextWindow: m.context_window ?? m.contextWindow ?? null,
                    isFree: m.is_free ?? null,
                    reasoning: m.is_reasoning ?? null,
                    efforts: m.reasoning_efforts || m.reasoningEfforts || null,
                    upstreamKey: m.upstream_key || null,
                  })),
                },
                accounts: status.accounts,
                inventory: status.inventory,
                quota: status.lastQuota,
                checkin: status.lastCheckin,
                checkinAttemptAt: status.lastCheckinAttempt,
                scheduler: status.scheduler || null,
                lastError: status.lastError,
                panelToken: shimTokenState(),
              });
            }

            if (method === 'POST' && sub === '/checkin') {
              const r = await runCheckin(true);
              return writeJson(res, 200, { ok: r.status === 200, result: r });
            }
            if (method === 'POST' && sub === '/refresh') {
              await refreshStatus();
              const n = await refreshModels();
              return writeJson(res, 200, { ok: true, models: n, quota: status.lastQuota });
            }
            if (method === 'POST' && sub === '/restart') {
              await hub.restart();
              await refreshStatus();
              return writeJson(res, 200, { ok: hub.running, port: hub.port });
            }
            return writeJson(res, 404, { error: 'not found' });
          } catch (e) {
            return writeJson(res, 500, { ok: false, error: e.message });
          }
        }

        const routes = [
          { path: `${basePath}/status`, handler: statusHandler },
          { path: `${basePath}/checkin`, handler: statusHandler },
          { path: `${basePath}/refresh`, handler: statusHandler },
          { path: `${basePath}/restart`, handler: statusHandler },
        ];
        for (const r of routes) {
          const dispose = register({ kind: 'exact', path: r.path, handler: r.handler });
          ctx.effect(() => () => { try { dispose?.(); } catch { /* ignore */ } }, `dsh-qoder2api-hub: ${r.path}`);
        }
        log(`status routes mounted at ${basePath}`);
      });
    });
  }

  function mountSettings() {
    guard('settings', () => {
      ctx.inject(['settings'], (settingsCtx) => {
        try {
          if (typeof settingsCtx.settings?.installSection !== 'function') {
            log('host settings service has no installSection API; status card unavailable');
            return;
          }
          settingsCtx.settings.installSection(ctx, SETTINGS_NS, SECTION_SCHEMA, {}, {
            setSource() { /* no-op */ },
            onChange() { /* no-op */ },
          });
        } catch (e) {
          log(`settings installSection skipped: ${e.message}`);
        }
      });
    });
  }

  async function init() {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!cfg.enabled) {
      log('disabled by config; nothing started');
      return;
    }
    const ok = await startAdapter();
    if (!ok) return;

    await refreshStatus();
    await runCheckin(false);

    timers.push(setInterval(() => guard('status', async () => {
      if (stopped) return;
      await refreshStatus();
    }), envInt(process.env.DSH_QODER_STATUS_POLL_MS, cfg.statusPollMs)));

    timers.push(setInterval(() => guard('models', async () => {
      if (stopped) return;
      await refreshModels();
    }), envInt(process.env.DSH_QODER_MODELS_POLL_MS, cfg.quotaPollMs)));

    // Daily check-in: fires on the configured local hour, once per calendar day.
    let lastClaimDay = '';
    timers.push(setInterval(() => guard('claim', async () => {
      if (stopped) return;
      const now = new Date();
      const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
      if (now.getHours() !== cfg.claimHour || lastClaimDay === day) return;
      lastClaimDay = day;
      log(`daily check-in sweep (${day})`);
      await runCheckin(true);
    }), 60000));
  }

  mountRoutes();
  mountSettings();
  guard('init', () => { init(); });

  return () => {
    stopped = true;
    for (const t of timers) { try { clearInterval(t); } catch { /* ignore */ } }
    if (releaseAdapter) { try { releaseAdapter(); } catch { /* ignore */ } }
    try { shim?.close(); } catch { /* ignore */ }
    hub.stop().catch(() => { /* ignore */ });
  };
}

export { findPython, pythonHint };
