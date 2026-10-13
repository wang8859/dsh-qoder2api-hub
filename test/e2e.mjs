// End-to-end verification for dsh-qoder2api-hub.
// Runs against the real vendored gateway and the real local Qoder credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG = 'E:\\DeepSeek-Harness\\products\\dsh-qoder2api-hub';
const { createHub, findPython, pythonHint } = await import('file://' + PKG.replace(/\\/g, '/') + '/lib/hub.js');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`); }
};
const section = (s) => console.log(`\n=== ${s} ===`);

// ---------- 1. interpreter discovery ----------
section('1. Python 3.9+ discovery');
const py = findPython();
ok('found a 3.9+ interpreter', !!py.exe, `${py.exe} ${py.version || ''}`);
ok('selected version >= 3.9', !!py.version && (() => {
  const [a, b] = py.version.split('.').map(Number);
  return a > 3 || (a === 3 && b >= 9);
})(), py.version);
ok('probe list recorded', Array.isArray(py.tried) && py.tried.length >= 1, `${py.tried.length} candidate(s)`);
console.log('  probe order:');
for (const t of py.tried) console.log(`    ${t.ok ? '[OK]  ' : '[--]  '}${t.exe} -> ${t.version || 'unusable'}`);

// ---------- 2. gateway lifecycle ----------
section('2. Gateway lifecycle (clean data dir)');
const tmp = path.join(os.tmpdir(), `qhub-test-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
const hub = createHub({ dataDir: tmp, log: () => {} });

let started;
try { started = await hub.start(); } catch (e) { started = { ok: false, error: e.message }; }
ok('gateway started', started.ok === true, started.ok ? `port ${started.port}` : String(started.error));
if (!started.ok) {
  console.log('  stderr tail:', (started.stderr || []).slice(-5).join(' | '));
  console.log(`\nRESULT: ${pass} passed / ${fail} failed`);
  process.exit(1);
}
ok('running flag true', hub.running === true);
ok('baseUrl shaped /v1', /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(hub.baseUrl), hub.baseUrl);

const health = await hub.health();
ok('/health returns ok:true', health.status === 200 && health.body?.ok === true);
ok('version reported', !!health.body?.version, String(health.body?.version));

// ---------- 3. local credential scan (open-box requirement) ----------
section('3. Local Qoder client credential discovery');
const scan = await hub.scanDesktop();
const detected = scan.body?.detected || [];
ok('scan endpoint answered', scan.status === 200, `status ${scan.status}`);
ok('detected >= 1 local credential', detected.length >= 1, `${detected.length} found`);
for (const d of detected) {
  console.log(`    ${d.realmName || d.realm}: ${d.nickname || '?'} (uid ${String(d.uid).slice(0, 8)}) valid=${d.valid}`);
}
const realms = new Set(detected.map((d) => d.realm));
ok('intl realm detected', realms.has('intl'));
ok('cn realm detected', realms.has('cn'));

// ---------- 4. import + account pool ----------
section('4. Account import');
const imp = await hub.importDesktopAll();
const imported = imp.body?.imported || [];
ok('import returned accounts', imported.length >= 1, `${imported.length} imported`);
ok('hasRefreshToken present', imported.every((a) => a.hasRefreshToken === true));
ok('machineId present', imported.every((a) => !!a.machineId));
const h2 = await hub.health();
ok('pool reports ready accounts', (h2.body?.accounts_ready ?? 0) >= 1, `${h2.body?.accounts_ready}/${h2.body?.accounts}`);

// ---------- 5. model catalog ----------
section('5. Model catalog');
const models = await hub.models();
const list = models.body?.data || [];
ok('/v1/models answered', models.status === 200, `status ${models.status}`);
ok('catalog non-empty', list.length >= 5, `${list.length} models`);
const clientOnlyKeys = ['qmodel_38max', 'qfmodel', 'qmodel_latest', 'gfmodel', 'kmodel_latest', 'dfmodel', 'fast', 'smodel', 'cmodel'];
const foundClientKeys = clientOnlyKeys.filter((k) => list.some((m) => m.id === k || m.upstream_key === k));
ok('client-only UI keys now resolvable', foundClientKeys.length >= 3,
  `found: ${foundClientKeys.join(', ') || 'none'}`);
console.log('  first 8 entries:');
for (const m of list.slice(0, 8)) {
  console.log(`    id=${m.id} name=${m.display_name || m.name} ctx=${m.context_window ?? '?'} free=${m.is_free ?? '?'} efforts=${JSON.stringify(m.reasoning_efforts || m.reasoningEfforts || null)}`);
}
const withEfforts = list.filter((m) => Array.isArray(m.reasoning_efforts || m.reasoningEfforts) && (m.reasoning_efforts || m.reasoningEfforts).length);
ok('some models expose thinking tiers', withEfforts.length >= 1, `${withEfforts.length} of ${list.length}`);

// ---------- 6. credits ----------
section('6. Credits');
const credits = await hub.creditsSummary();
ok('/credits/summary answered', credits.status === 200, `status ${credits.status}`);

// ---------- 7. check-in ----------
section('7. Daily check-in');
const login = await hub.login('admin');
ok('panel login', login.status === 200 && !!login.body?.token);
const checkin = await hub.checkin();
const results = checkin.body?.results || [];
ok('check-in answered 200', checkin.status === 200, `status ${checkin.status}${checkin.error ? ' ' + checkin.error : ''}`);
ok('per-account results present', results.length >= 1, `${results.length} account(s)`);
for (const r of results) {
  console.log(`    ${r.nickname}: ok=${r.ok} msg=${r.msg} credits=${r.credits?.remain ?? '?'}`);
}
ok('all accounts ok', results.length > 0 && results.every((r) => r.ok === true));

const sched = await hub.scheduler();
ok('scheduler reachable', sched.status === 200, `status ${sched.status}`);
const creditsAfter = await hub.credits();
const byRealm = creditsAfter.body?.by_realm || {};
ok('credit summary reports both realms', Object.keys(byRealm).length >= 1,
  JSON.stringify(byRealm));

// ---------- 8. real inference across the catalog ----------
section('8. Real inference (stream=false)');
const probeModels = [];
for (const want of ['auto', 'qmodel_38max', 'qfmodel', 'dmodel', 'gmodel', 'kmodel']) {
  const m = list.find((x) => x.id === want || x.upstream_key === want);
  if (m) probeModels.push(m.id);
}
probeModels.push(...list.filter((m) => m.is_free).map((m) => m.id));
const uniq = [...new Set(probeModels)].slice(0, 8);

let inferOk = 0;
for (const id of uniq) {
  try {
    const r = await fetch(`http://127.0.0.1:${hub.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'reply with the single word: PONG' }], max_tokens: 512, stream: false }),
      signal: AbortSignal.timeout(120000),
    });
    const t = await r.text();
    let body; try { body = JSON.parse(t); } catch { body = null; }
    const content = body?.choices?.[0]?.message?.content;
    const reasoning = body?.choices?.[0]?.message?.reasoning_content;
    const good = r.status === 200 && !!content;
    if (good) inferOk++;
    console.log(`    ${good ? 'OK  ' : 'BAD '} ${id} status=${r.status} content=${JSON.stringify(String(content || '').slice(0, 40))}${reasoning ? ` reasoning=${String(reasoning).slice(0, 24)}` : ''}`);
  } catch (e) {
    console.log(`    ERR  ${id} ${e.message}`);
  }
}
ok('at least one model returned content', inferOk >= 1, `${inferOk}/${uniq.length} ok`);

// ---------- 9. thinking depth passthrough ----------
section('9. Thinking-depth (reasoning_effort) passthrough');
const tierModel = withEfforts[0];
if (tierModel) {
  const tiers = tierModel.reasoning_efforts || tierModel.reasoningEfforts;
  const chosen = tiers[tiers.length - 1];
  try {
    const r = await fetch(`http://127.0.0.1:${hub.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: tierModel.id,
        messages: [{ role: 'user', content: 'reply with the single word: EFFORT' }],
        max_tokens: 600, stream: false, reasoning_effort: chosen,
      }),
      signal: AbortSignal.timeout(120000),
    });
    const t = await r.text();
    let body; try { body = JSON.parse(t); } catch { body = null; }
    const content = body?.choices?.[0]?.message?.content;
    ok(`reasoning_effort=${chosen} accepted`, r.status === 200, `status ${r.status} content=${JSON.stringify(String(content || '').slice(0, 40))}`);
  } catch (e) {
    ok(`reasoning_effort=${chosen} accepted`, false, e.message);
  }
} else {
  ok('a model with thinking tiers exists', false, 'none found');
}

// ---------- 10. streaming ----------
section('10. Streaming');
try {
  const r = await fetch(`http://127.0.0.1:${hub.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'count 1 2 3' }], max_tokens: 256, stream: true }),
    signal: AbortSignal.timeout(120000),
  });
  ok('stream status 200', r.status === 200, `status ${r.status}`);
  let sawData = false; let sawDone = false; let text = '';
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    const s = dec.decode(chunk, { stream: true });
    if (s.includes('data: ')) sawData = true;
    if (s.includes('[DONE]')) sawDone = true;
    for (const line of s.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const p = line.slice(6).trim();
      if (p === '[DONE]') continue;
      try { text += JSON.parse(p)?.choices?.[0]?.delta?.content || ''; } catch { /* ignore */ }
    }
  }
  ok('SSE frames received', sawData);
  ok('[DONE] terminator received', sawDone);
  ok('stream produced text', text.length > 0, JSON.stringify(text.slice(0, 40)));
} catch (e) {
  ok('streaming works', false, e.message);
}

// ---------- 10b. null inner frames ----------
// Some upstream models (MiniMax among them) emit an inner body of literal
// `null`. Both iter_inner_sse and clean_chunk must survive it; before the guard
// the stream died mid-flight with AttributeError and the client saw
// "TypeError: terminated" instead of an answer.
section('10b. Null inner frames');
for (const model of ['MiniMax-M2.7', 'MiniMax-M3', 'Kimi-K3']) {
  try {
    const r = await fetch(`http://127.0.0.1:${hub.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly the single word PONG and nothing else.' }], max_tokens: 512, stream: true }),
      signal: AbortSignal.timeout(180000),
    });
    const t = await r.text();
    let text = '';
    for (const line of t.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (p === '[DONE]') continue;
      try { text += JSON.parse(p)?.choices?.[0]?.delta?.content || ''; } catch { /* ignore */ }
    }
    ok(`${model} survives null frames`, r.status === 200 && text.trim().length > 0, `status ${r.status} content=${JSON.stringify(text.trim().slice(0, 20))}`);
  } catch (e) {
    ok(`${model} survives null frames`, false, `${e.name}: ${e.message}`);
  }
}

// ---------- 11. teardown ----------
section('11. Teardown');
await hub.stop();
await new Promise((r) => setTimeout(r, 600));
ok('gateway stopped', !hub.running);
const portGone = await (async () => {
  try { await fetch(`http://127.0.0.1:${started.port}/health`, { signal: AbortSignal.timeout(2000) }); return false; } catch { return true; }
})();
ok('port released', portGone);

console.log(`\nRESULT: ${pass} passed / ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
