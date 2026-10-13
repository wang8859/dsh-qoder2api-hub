"""Runtime settings for the Qoder gateway: panel password and API keys.

Everything lives in `accounts/settings.json` so a change made from the web
panel survives a restart without editing the launcher .bat files. The panel
password is never stored in clear text - only a PBKDF2-SHA256 digest.

Only the Python standard library is required.
"""

import fnmatch
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path

DEFAULT_PANEL_PASSWORD = "admin"
PBKDF2_ROUNDS = 120_000
SESSION_TTL = 7 * 24 * 3600

_lock = threading.RLock()


def settings_path(accounts_dir):
    return os.path.join(accounts_dir, "settings.json")


def _digest(password, salt_hex, rounds=PBKDF2_ROUNDS):
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), rounds
    ).hex()


def load(accounts_dir):
    """Return the persisted settings, or an empty dict on a fresh install."""
    path = settings_path(accounts_dir)
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            return data
    except FileNotFoundError:
        pass
    except Exception:
        pass
    return {}


def save(accounts_dir, data):
    """Atomic write so a crash cannot leave a half-written settings file."""
    with _lock:
        base = Path(accounts_dir).resolve()
        base.mkdir(parents=True, exist_ok=True)
        path = base / "settings.json"
        tmp = base / "settings.json.tmp"
        if not (path.is_relative_to(base) and tmp.is_relative_to(base)):
            raise ValueError("path escapes base directory")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                       encoding="utf-8")
        os.replace(tmp, path)
        return str(path)


def panel_password_is_default(accounts_dir):
    data = load(accounts_dir)
    if not data.get("panel_password_hash"):
        return True
    return data.get("panel_password_default") is True


def verify_panel_password(accounts_dir, password):
    """True when `password` opens the web panel."""
    password = password or ""
    data = load(accounts_dir)
    stored = data.get("panel_password_hash")
    if not stored:
        return password == DEFAULT_PANEL_PASSWORD
    if data.get("panel_password_default") is True:
        return password == DEFAULT_PANEL_PASSWORD
    salt = data.get("panel_password_salt")
    if not salt:
        return False
    rounds = int(data.get("panel_password_rounds") or PBKDF2_ROUNDS)
    try:
        given = _digest(password, salt, rounds)
    except Exception:
        return False
    return hmac.compare_digest(given, stored)


def set_panel_password(accounts_dir, password):
    with _lock:
        data = load(accounts_dir)
        if password == DEFAULT_PANEL_PASSWORD:
            data.pop("panel_password_salt", None)
            data.pop("panel_password_rounds", None)
            data["panel_password_hash"] = ""
            data["panel_password_default"] = True
        else:
            salt = secrets.token_hex(16)
            data["panel_password_salt"] = salt
            data["panel_password_rounds"] = PBKDF2_ROUNDS
            data["panel_password_hash"] = _digest(password, salt)
            data["panel_password_default"] = False
        save(accounts_dir, data)


def api_key_override(accounts_dir):
    """Return (key, is_set). `is_set` means the panel manages the key."""
    data = load(accounts_dir)
    if not data.get("api_key_set"):
        return None, False
    return str(data.get("api_key") or ""), True


def set_api_key(accounts_dir, key):
    with _lock:
        data = load(accounts_dir)
        data["api_key"] = key or ""
        data["api_key_set"] = True
        save(accounts_dir, data)


def ensure_launcher_key(accounts_dir):
    """Return the persisted LAN key, creating one on first use.

    LAN mode must never ship a well-known default: the gateway spends the
    account's own upstream quota, so anyone on the same network could drain it.
    The value is generated once and stored so clients keep working across
    restarts. Returns (key, created) so the caller can tell the user whether
    this run minted a fresh credential.
    """
    with _lock:
        data = load(accounts_dir)
        existing = str(data.get("launcher_key") or "").strip()
        if existing:
            return existing, False
        key = "qd-" + secrets.token_urlsafe(24)
        data["launcher_key"] = key
        save(accounts_dir, data)
        return key, True


# --------------------------------------------------------------- API keys
# Each key can be bound to one upstream realm, so several clients can hit
# different exits at the same time instead of sharing the global switch.

REALMS = ("", "intl", "cn")


def _clean_key_entry(entry):
    """Normalize one stored key entry; returns None when unusable."""
    if not isinstance(entry, dict):
        return None
    key = str(entry.get("key") or "").strip()
    if not key:
        return None
    realm = str(entry.get("realm") or "").strip().lower()
    if realm not in REALMS:
        realm = ""
    return {
        "id": str(entry.get("id") or secrets.token_hex(6)),
        "name": str(entry.get("name") or "").strip() or "未命名",
        "key": key,
        "realm": realm,
        "enabled": entry.get("enabled", True) is not False,
        "created_at": entry.get("created_at") or time.strftime("%Y/%m/%d %H:%M"),
        # P1-4：每 Key 模型白名单（空列表 = 不限制）。**必须显式保留**——
        # 本函数是白名单式重建，漏掉即「保存时被静默丢弃」（limits 同型坑）。
        "models": _clean_model_patterns(entry.get("models")),
    }


def api_keys(accounts_dir):
    """Every configured key, newest shape first.

    A settings file written by an older build only has the single
    `api_key`/`api_key_set` pair; that is surfaced as one unbound entry so
    upgrades keep working without a migration step.
    """
    data = load(accounts_dir)
    stored = data.get("api_keys")
    if isinstance(stored, list):
        out = []
        seen = set()
        for raw in stored:
            entry = _clean_key_entry(raw)
            if entry and entry["key"] not in seen:
                seen.add(entry["key"])
                out.append(entry)
        return out

    if data.get("api_key_set"):
        legacy = str(data.get("api_key") or "").strip()
        if legacy:
            return [{
                "id": "legacy",
                "name": "默认（跟随面板切换）",
                "key": legacy,
                "realm": "",
                "enabled": True,
            }]
    return []


def set_api_keys(accounts_dir, keys):
    """Replace the whole key list. Returns the stored list."""
    with _lock:
        cleaned = []
        seen = set()
        for raw in keys or []:
            entry = _clean_key_entry(raw)
            if entry and entry["key"] not in seen:
                seen.add(entry["key"])
                cleaned.append(entry)
        data = load(accounts_dir)
        data["api_keys"] = cleaned
        # The single-key fields are now derived; drop them so there is one
        # source of truth and the list survives a restart.
        data.pop("api_key", None)
        data.pop("api_key_set", None)
        save(accounts_dir, data)
        return cleaned


def match_api_key(accounts_dir, supplied, extra_keys=()):
    """Find which configured key a request presented, if any.

    Returns a copy of the entry (with a `source` field) so the caller can read
    the bound realm, or None when nothing matches.
    """
    supplied = (supplied or "").strip()
    if not supplied:
        return None
    for entry in api_keys(accounts_dir):
        if entry["enabled"] and hmac.compare_digest(supplied, entry["key"]):
            out = dict(entry)
            out["source"] = "panel"
            return out
    for candidate in extra_keys:
        candidate = (candidate or "").strip()
        if candidate and hmac.compare_digest(supplied, candidate):
            return {
                "id": "launcher",
                "name": "启动参数",
                "key": candidate,
                "realm": "",
                "enabled": True,
                "source": "launcher",
            }
    return None


def auth_disabled(accounts_dir):
    """True when the operator switched API-key checking off entirely."""
    return load(accounts_dir).get("auth_disabled") is True


def set_auth_disabled(accounts_dir, disabled):
    with _lock:
        data = load(accounts_dir)
        data["auth_disabled"] = bool(disabled)
        save(accounts_dir, data)


# ------------------------------------------------------------- model gates
# P1-4：模型闸门配置层。全局封禁（banned_models）与每 Key 白名单（key 条目的
# models 字段）共用同一套 pattern 清洗与匹配：fnmatch 通配、大小写不敏感；
# **默认空 = 不封禁 / 不限制**（未碰这两个配置的安装行为与改动前一致）。
_MODEL_SPLIT = re.compile(r"[,;\n]")


def _clean_model_patterns(value):
    """把 字符串 / 列表 / 集合 清洗成 pattern 列表（strip+lower+去重+去空）。

    非法类型返回 []（fail-open：读配置永远不抛）。
    """
    if isinstance(value, str):
        raw = _MODEL_SPLIT.split(value)
    elif isinstance(value, (list, tuple, set)):
        raw = list(value)
    else:
        return []
    out = []
    for item in raw:
        pattern = str(item or "").strip().lower()
        if pattern and pattern not in out:
            out.append(pattern)
    return out


def key_allows_model(entry, model):
    """True = 该 Key 未设模型限制，或 model 命中它的 models 列表。

    - 空列表（或字段缺失）= 不受限（未碰过这个字段的安装行为不变）；
    - 受限 Key 且 model 为空 = **拒绝**（wb 同语义：空模型没有可判定依据，
      放行只会带着空模型白跑一趟上游）；
    - 匹配 fnmatch（大小写已在清洗时统一为小写），支持 gpt-4* 这类通配。
    """
    patterns = _clean_model_patterns((entry or {}).get("models"))
    if not patterns:
        return True
    name = str(model or "").strip().lower()
    if not name:
        return False
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in patterns)


def banned_models(accounts_dir):
    """全局封禁的模型 pattern 列表（settings 键 banned_models；默认空）。"""
    with _lock:
        raw = load(accounts_dir).get("banned_models")
    return _clean_model_patterns(raw)


def set_banned_models(accounts_dir, value):
    """落盘全局封禁列表（清洗后存储；空 = 不封禁任何模型）。返回清洗结果。"""
    patterns = _clean_model_patterns(value)
    with _lock:
        data = load(accounts_dir)
        data["banned_models"] = patterns
        save(accounts_dir, data)
    return patterns


class PanelSessions(object):
    """In-memory bearer tokens handed out after a successful panel login.

    Deliberately not persisted: restarting the gateway logs browsers out, which
    is the safer default for a LAN tool that people expose behind a port map.
    """

    def __init__(self, ttl=SESSION_TTL):
        self.ttl = ttl
        self._tokens = {}
        self._lock = threading.RLock()

    def create(self):
        token = secrets.token_urlsafe(24)
        with self._lock:
            self._tokens[token] = time.time() + self.ttl
        return token

    def valid(self, token):
        if not token:
            return False
        with self._lock:
            expiry = self._tokens.get(token)
            if not expiry:
                return False
            if expiry < time.time():
                self._tokens.pop(token, None)
                return False
            return True

    def revoke(self, token):
        if not token:
            return
        with self._lock:
            self._tokens.pop(token, None)

    def revoke_all(self):
        with self._lock:
            self._tokens.clear()


# ---------------------------------------------------------------- limits
# 四个守卫共享同一形状：一个覆盖双区域的 global 默认值 + 可选的 per-realm
# override。**留空 = 继承 global**（与显式 0 = "关闭"严格区分）；从不碰这份
# 配置的安装，行为与没有它完全一致。形状照抄 wb_settings.py 的三条读/写入口
# + 分组 map，但 qoder 侧 **默认值全部为 0（关闭）**——量纲尚未核对
# （.team/_gap/03-candidate-deep-dive.md R4），不给任何非零默认。
LIMIT_KEYS = ("reserve_credits", "daily_token_limit",
              "daily_credit_limit", "model_daily_token_limit",
              "expiring_window_days")
LIMIT_REALMS = ("intl", "cn")
LIMIT_SCOPES = ("global",) + LIMIT_REALMS
LIMITS_KEY = "limits"


def _empty_limit_entry():
    """一个守卫的空条目：global 默认 0（关），两个 realm 槽位 None=继承。"""
    return {"global": 0, "intl": None, "cn": None}


def _coerce_global(value):
    """global 阈值：垃圾值与负数收敛到 0（关）。"""
    try:
        number = int(value or 0)
    except (TypeError, ValueError):
        number = 0
    return max(0, number)


def _coerce_override(value):
    """per-realm override：None/空串="继承 global"（与显式 0="本区域关闭"不同）。"""
    if value is None or value == "":
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return max(0, number)


def _normalize_limits(raw):
    """把存储的 map 补全成完整形状（部分/手改的 settings.json 也安全读）。"""
    limits = {}
    for key in LIMIT_KEYS:
        entry = raw.get(key)
        if not isinstance(entry, dict):
            entry = {}
        global_raw = entry.get("global")
        # 缺省 global → 0（关）；显式 0 是真实的"关"，不会被误重新打开。
        limits[key] = {
            "global": 0 if global_raw is None else _coerce_global(global_raw),
            "intl": _coerce_override(entry.get("intl")),
            "cn": _coerce_override(entry.get("cn")),
        }
    return limits


def limits_data(accounts_dir):
    """分组后的 limits map（每个守卫都补全为完整形状）。

    qoder 从未有过旧扁平键，因此不做 wb 的 _fold_legacy_limits 迁移分支。
    """
    with _lock:
        raw = load(accounts_dir).get(LIMITS_KEY)
        return _normalize_limits(raw if isinstance(raw, dict) else {})


def limit_value(accounts_dir, key, realm=None):
    """单守卫、单区域的**生效值**。

    realm 为 intl/cn 且有 override 时用 override，否则回落 global；
    未知 key 读作 0（关），不卡请求路径（与 wb 同语义）。
    """
    entry = limits_data(accounts_dir).get(key) or _empty_limit_entry()
    if realm in LIMIT_REALMS:
        override = entry.get(realm)
        if override is not None:
            return override
    return entry.get("global") or 0


def limit_values(accounts_dir, key):
    """单守卫 → {"global": g, "intl": ..., "cn": ...}（intl/cn 已把 global 填好）。

    热路径上每个账号按自己的 realm 取一次即可；保证三键齐全且 intl/cn 非
    None（验收 A5）。
    """
    entry = limits_data(accounts_dir).get(key) or _empty_limit_entry()
    global_value = entry.get("global") or 0
    values = {"global": global_value}
    for realm in LIMIT_REALMS:
        override = entry.get(realm)
        values[realm] = global_value if override is None else override
    return values


def set_limit(accounts_dir, key, scope, value):
    """落盘单个守卫的单个作用域；返回该守卫的完整条目。

    key 不在 LIMIT_KEYS、scope 不在 LIMIT_SCOPES 时抛 ValueError；
    scope="global" 恒存数字（None/垃圾→0）；intl/cn 传 None/空串 =
    清除 override 回到继承。
    """
    if key not in LIMIT_KEYS:
        raise ValueError("unknown limit: %s" % key)
    if scope not in LIMIT_SCOPES:
        raise ValueError("unknown scope: %s" % scope)
    with _lock:
        data = load(accounts_dir)
        raw = data.get(LIMITS_KEY)
        limits = _normalize_limits(raw if isinstance(raw, dict) else {})
        entry = limits[key]
        if scope == "global":
            entry["global"] = _coerce_global(value)
        else:
            entry[scope] = _coerce_override(value)
        data[LIMITS_KEY] = limits
        save(accounts_dir, data)
    return entry
