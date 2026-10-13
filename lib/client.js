// client.js — dsh-qoder2api-hub settings card.
// Shows what the vendored gateway actually reports: sign-in state, credit balance, the
// daily check-in result, and the live model list.
//
// Iron rules (violating any of these stops the whole DSH from opening):
//   1. exports.inject must declare BOTH "slots" and "locale".
//   2. All hooks stay above any conditional return.
//   3. Every contribution point is wrapped in a guard.

const SETTINGS_KEY = 'qoder2api-hub';
const LOCALE_NS = 'settings.qoder2api-hub';
const BUNDLE_NAME = 'dsh-qoder2api-hub';
const PLUGIN_API = '/plugins/dsh-qoder2api-hub';

window.__ModuleLoader__.load({
  id: BUNDLE_NAME,
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const module = { exports: {} };
    const exports = module.exports;

    const NS = 'dsh-qoder2api-hub';

    const zh = {
      title: 'Qoder 反代（qoder2api-hub）',
      desc: '本机跑 qoder2api-hub 网关，把 Qoder / Qoder CN 的模型接入 DSH，并自动处理每日签到。',
      backend: '后端',
      running: '运行中',
      stopped: '未运行',
      python: 'Python',
      adapter: '适配器',
      active: '已注册',
      inactive: '未注册',
      accounts: '账号',
      signin: '登录态',
      signed_in: '已登录',
      not_signed_in: '未登录',
      credits: '积分',
      remaining: '剩余',
      used: '已用',
      expires: '到期',
      checkin: '每日签到',
      checkin_last: '上次签到',
      checkin_ok: '成功',
      checkin_fail: '失败',
      checkin_now: '立即签到',
      checkin_never: '尚未执行',
      models: '可用模型',
      models_count: '个模型',
      refresh: '刷新',
      restart: '重启后端',
      loading: '加载中…',
      error: '错误',
      no_models: '暂无模型',
      free: '免费',
      thinking: '思考档位',
      scheduler: '调度器',
      enabled: '已启用',
      disabled: '已停用',
      next_run: '下次运行',
      hint_python: '未找到 Python 3.9+，请安装后重启 DSH',
      realm_intl: '国际版',
      realm_cn: '国内版',
      detail: '详情',
      hide: '收起',
    };
    const en = {
      title: 'Qoder Proxy (qoder2api-hub)',
      desc: 'Runs the qoder2api-hub gateway locally and exposes Qoder / Qoder CN models to DSH, with automatic daily check-in.',
      backend: 'Backend',
      running: 'Running',
      stopped: 'Stopped',
      python: 'Python',
      adapter: 'Adapter',
      active: 'Registered',
      inactive: 'Not registered',
      accounts: 'Accounts',
      signin: 'Sign-in',
      signed_in: 'Signed in',
      not_signed_in: 'Not signed in',
      credits: 'Credits',
      remaining: 'left',
      used: 'used',
      expires: 'Expires',
      checkin: 'Daily check-in',
      checkin_last: 'Last check-in',
      checkin_ok: 'OK',
      checkin_fail: 'Failed',
      checkin_now: 'Check in now',
      checkin_never: 'Not yet run',
      models: 'Models',
      models_count: 'models',
      refresh: 'Refresh',
      restart: 'Restart backend',
      loading: 'Loading…',
      error: 'Error',
      no_models: 'No models',
      free: 'free',
      thinking: 'thinking',
      scheduler: 'Scheduler',
      enabled: 'enabled',
      disabled: 'disabled',
      next_run: 'Next run',
      hint_python: 'Python 3.9+ not found; install it and restart DSH',
      realm_intl: 'International',
      realm_cn: 'China',
      detail: 'Details',
      hide: 'Hide',
    };

    function guardClientContribution(where, fn) {
      try {
        const r = fn();
        if (r && typeof r.catch === 'function') {
          r.catch((e) => console.error(`[${NS}] ${where} async error:`, e));
        }
        return r;
      } catch (e) {
        console.error(`[${NS}] ${where} error:`, e);
        return undefined;
      }
    }

    async function api(path, opts) {
      const resp = await fetch(`${PLUGIN_API}${path}`, {
        method: opts?.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(j?.error || j?.message || `HTTP ${resp.status}`);
      return j;
    }

    function fmtTime(ms) {
      if (!ms) return '—';
      try {
        const d = typeof ms === 'number' && ms < 1e12 ? new Date(ms * 1000) : new Date(ms);
        return d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      } catch { return '—'; }
    }

    const pill = {
      display: 'inline-block',
      padding: '2px 10px',
      borderRadius: 999,
      fontSize: 12,
      lineHeight: '18px',
      background: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.12))',
      color: 'var(--dsw-alias-label-secondary, inherit)',
      marginRight: 8,
    };
    const pillOk = {
      ...pill,
      background: 'color-mix(in srgb, var(--dsw-alias-state-success, #22a06b) 18%, transparent)',
      color: 'var(--dsw-alias-state-success, #22a06b)',
    };
    const pillBad = {
      ...pill,
      background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #d64545) 16%, transparent)',
      color: 'var(--dsw-alias-state-error-primary, #d64545)',
    };
    const card = {
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))',
      borderRadius: 12,
      padding: '14px 16px',
      marginBottom: 12,
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      boxShadow: 'var(--dsw-shadow-lv2, none)',
    };
    const btn = {
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))',
      borderRadius: 8,
      padding: '5px 12px',
      fontSize: 13,
      cursor: 'pointer',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      marginRight: 8,
    };
    const btnPrimary = {
      ...btn,
      background: 'var(--dsw-alias-button-primary-fill, #4f6ef2)',
      borderColor: 'transparent',
      color: 'var(--dsw-alias-label-primary-foreground, #fff)',
    };
    const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 };
    const label = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)', marginRight: 4 };
    const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 };
    const modelBox = {
      display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8,
      maxHeight: 190, overflowY: 'auto',
    };
    const modelChip = {
      ...pill,
      marginRight: 0,
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18))',
      background: 'transparent',
    };

    function AccountRow({ a, t }) {
      const realm = a.realm === 'cn' ? t('realm_cn') : t('realm_intl');
      const credits = a.credits || {};
      const hasCredits = credits.remain !== undefined && credits.remain !== null;
      return h('div', { style: { ...row, borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.12))', paddingTop: 8 } },
        h('span', { style: pillOk }, realm),
        h('span', { style: { fontWeight: 500 } }, a.nickname || a.uid?.slice(0, 8) || '—'),
        a.lastError ? h('span', { style: pillBad }, a.lastError.slice(0, 60)) : null,
        hasCredits
          ? h('span', { style: label },
            `${t('remaining')} ${credits.remain}${credits.size ? ` / ${credits.size}` : ''}${credits.usage_pct !== undefined ? ` · ${Math.round(credits.usage_pct * 100)}% ${t('used')}` : ''}`)
          : null,
        a.expiresIn ? h('span', { style: label }, `${t('expires')} ${a.expiresIn}`) : null,
      );
    }

    function HubCard(props) {
      const { t } = props;
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [showModels, setShowModels] = React.useState(false);

      const load = React.useCallback(async () => {
        try {
          const j = await api('/status');
          setData(j);
          setError(null);
        } catch (e) {
          setError(e.message);
        } finally {
          setLoading(false);
        }
      }, []);

      React.useEffect(() => {
        load();
        const iv = setInterval(load, 30000);
        return () => clearInterval(iv);
      }, [load]);

      const act = async (path) => {
        setBusy(true);
        try {
          await api(path, { method: 'POST' });
          await load();
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      };

      const backend = data?.backend || {};
      const credits = data?.quota || {};
      const checkin = data?.checkin || null;
      const models = Array.isArray(data?.models?.list) ? data.models.list : [];
      const accounts = Array.isArray(data?.inventory) ? data.inventory : [];
      const sched = data?.scheduler || null;

      const byRealm = credits.by_realm || null;
      const totals = credits.totals || null;
      const checkinResults = Array.isArray(checkin?.results) ? checkin.results : [];
      const checkinOk = checkin?.status === 200;

      return h('div', null,
        h('div', { style: { fontWeight: 600, marginBottom: 4 } }, t('title')),
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)', marginBottom: 10 } }, t('desc')),

        error ? h('div', { style: { ...row, color: 'var(--dsw-alias-state-error-primary, #d64545)' } }, `${t('error')}: ${error}`) : null,
        loading && !data ? h('div', { style: row }, t('loading')) : null,

        data ? h('div', { style: card },
          h('div', { style: { ...row, justifyContent: 'space-between' } },
            h('span', { style: data.running && data.adapter?.active ? pillOk : pillBad },
              `${t('backend')}: ${data.running ? t('running') : t('stopped')}`),
            h('span', { style: data.adapter?.active ? pillOk : pill }, `${t('adapter')}: ${data.adapter?.active ? t('active') : t('inactive')}`)),
          h('div', { style: row },
            h('span', { style: label }, t('python')),
            h('span', { style: mono }, backend.pythonVersion || '—'),
            h('span', { style: label }, '→'),
            h('span', { style: mono }, `127.0.0.1:${backend.port || '—'}`),
            backend.up === false ? h('span', { style: pillBad }, backend.lastError || t('stopped')) : null),
          backend.lastError && backend.up ? h('div', { style: { ...row, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' } }, backend.lastError) : null,
          backend.exit ? h('div', { style: { ...row, fontSize: 12 } }, `exit code=${backend.exit.code}`) : null,
        ) : null,

        data ? h('div', { style: card },
          h('div', { style: { fontWeight: 600, fontSize: 13 } },
            `${t('credits')}${totals?.remain !== undefined ? ` · ${t('remaining')} ${totals.remain}` : ''}`),
          byRealm ? h('div', { style: row },
            byRealm.intl !== undefined ? h('span', { style: pill }, `${t('realm_intl')} ${byRealm.intl}`) : null,
            byRealm.cn !== undefined ? h('span', { style: pill }, `${t('realm_cn')} ${byRealm.cn}`) : null) : null,
          accounts.length
            ? accounts.map((a) => h(AccountRow, { key: a.uid, a, t }))
            : h('div', { style: { ...row, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' } }, t('not_signed_in')),
          (!accounts.length && data.accounts) ? h('div', { style: { ...row, fontSize: 12 } },
            `${t('accounts')}: ${data.accounts.ready ?? '?'} / ${data.accounts.total ?? '?'}`) : null,
        ) : null,

        data ? h('div', { style: card },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('checkin')),
            checkin ? h('span', { style: checkinOk ? pillOk : pillBad }, checkinOk ? t('checkin_ok') : t('checkin_fail')) : h('span', { style: pill }, t('checkin_never'))),
          h('div', { style: row },
            h('span', { style: label }, t('checkin_last')),
            h('span', { style: { fontSize: 12 } }, checkin ? fmtTime(checkin.at) : t('checkin_never')),),
          sched ? h('div', { style: row },
            h('span', { style: label }, t('scheduler')),
            h('span', { style: sched.enabled ? pillOk : pill }, sched.enabled ? t('enabled') : t('disabled')),
            sched.next_run_time ? h('span', { style: { fontSize: 12 } }, `${t('next_run')}: ${sched.next_run_time}`) : null) : null,
          checkinResults.length ? h('div', { style: { marginTop: 8 } },
            checkinResults.map((r, i) => h('div', { key: r.uid || i, style: { fontSize: 12, marginTop: 4 } },
              h('span', { style: r.ok ? pillOk : pillBad }, r.ok ? '✓' : '✗'),
              `${r.nickname || r.uid?.slice(0, 8) || ''} · ${r.msg || r.message || r.error || ''}`))) : null,
          h('div', { style: row },
            h('button', { style: btnPrimary, disabled: busy || !data?.running, onClick: () => act('/checkin') }, t('checkin_now')),
            h('button', { style: btn, disabled: busy, onClick: () => act('/refresh') }, t('refresh')),
            h('button', { style: btn, disabled: busy, onClick: () => act('/restart') }, t('restart'))),
        ) : null,

        data ? h('div', { style: card },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('span', { style: { fontWeight: 600, fontSize: 13 } },
              `${t('models')} · ${data.models?.count || 0}`),
            h('button', { style: btn, onClick: () => setShowModels((s) => !s) },
              showModels ? t('hide') : t('detail'))),
          data.models?.error ? h('div', { style: { ...row, fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #d64545)' } }, data.models.error) : null,
          models.length === 0 ? h('div', { style: { ...row, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' } }, t('no_models')) : null,
          h('div', { style: modelBox },
            (showModels ? models : models.slice(0, 12)).map((m) => h('span', {
              key: m.id, style: modelChip, title: m.upstreamKey ? `upstream: ${m.upstreamKey}` : m.id,
            }, m.name || m.id,
              m.isFree ? h('span', { style: { marginLeft: 6, opacity: 0.7 } }, t('free')) : null,
              Array.isArray(m.efforts) && m.efforts.length
                ? h('span', { style: { marginLeft: 6, opacity: 0.7 } }, `${t('thinking')} ${m.efforts.length}`) : null))),
          (!showModels && models.length > 12)
            ? h('div', { style: { ...row, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' } }, `+${models.length - 12}`) : null,
        ) : null,

        (backend.python === null && data && !data.running && backend.lastError)
          ? h('div', { style: { ...row, fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #d64545)' } }, t('hint_python'))
          : null,
      );
    }

    function apply(ctx) {
      guardClientContribution('locale.register', () => ctx.effect(
        () => ctx.locale.register(LOCALE_NS, { zh, en }), 'qoder2api-hub.locale'));

      const t = ctx.locale.bind(LOCALE_NS);

      guardClientContribution('slots.settings.plugin.item', () => ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: SETTINGS_KEY,
        priority: 30,
        inject: () => ({ t }),
      }, HubCard)));

      guardClientContribution('slots.plugins.bundle.config', () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE_NAME,
        locale: LOCALE_NS,
      }, HubCard)));
    }

    exports.name = 'dsh-qoder2api-hub-client';
    exports.inject = ['slots', 'locale'];
    exports.apply = apply;
    return module.exports;
  },
});
