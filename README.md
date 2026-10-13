# dsh-qoder2api-hub

把本机已登录的 **Qoder** / **Qoder CN** 客户端变成 DSH 里可直接调用的模型 provider。

插件自带一个完整的 Qoder 反向代理网关（vendored [qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub)，零第三方 Python 依赖），由 DSH 生命周期托管：启用插件即自动拉起网关、导入本机凭据、拉取真实模型目录、余额与签到状态，并在 DSH 模型选择器里注册 `qoder` provider 分组。

## 功能

- **登录态读取**：自动扫描本机 Qoder 客户端凭据（`auth.v1.dat`），导入国际版与 CN 版账号，无需手工填 token。
- **真实模型目录**：网关解密本机客户端缓存拿到官方模型清单，包含 `Qwen3.8-Max`、`Qwen3.8-Flash`、`DeepSeek-V4-Pro`、`GLM-5.3`、`Kimi-K3`、`MiniMax-M2.7` 等，而非手工维护的静态快照。
- **积分查询**：按账号、按区域（intl / cn）汇总余额，含基础额度与赠送/签到额度的分包明细。
- **每日自动签到**：网关内置调度器按整点巡检，自动领取每日活动积分并保活 token；DSH 内也可手动触发。
- **思考程度原样透传**：请求里的 `reasoning_effort` 不做任何改写，按客户端选的档位字节原样下发上游。
- **状态卡片**：DSH 设置页展示登录态、积分余额、签到结果、可用模型列表。

## 环境要求

- Node.js 18 或更高（DSH 自带）
- **Python 3.9 或更高**（网关是 Python 写的；3.9 以下会因为 `str.removeprefix` 等 3.9+ API 直接崩）
- 本机装过并**至少登录过一次** Qoder 或 Qoder CN 客户端

插件启动时会自己找 Python：先看环境变量 `DSH_QODER_PYTHON`，再依次找 uv 的 Python 目录、`%LOCALAPPDATA%\Programs\Python`、`C:\Program Files`、miniconda3 / anaconda3，最后回落 PATH 里的 `python3` / `python`。找到的版本低于 3.9 会被跳过并在状态里报错。

如果自动发现失败，手动指定解释器：

```powershell
setx DSH_QODER_PYTHON "C:\path\to\python.exe"
```

## 安装

```powershell
dsh plugin add dsh-qoder2api-hub
```

装完重启 DSH。首次启动会自动完成：拉起网关 → 扫描本机凭据 → 导入账号 → 拉模型目录 → 执行一次签到巡检。

不需要改任何配置文件。安装后 DSH 模型选择器会多出一个 **Qoder (qoder2api-hub)** 分组，直接选模型即可。

## 配置

全部有默认值，可以不动。在 DSH 设置里改：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉则什么都不启动 |
| `port` | `0` | 网关监听端口，`0` = 自动挑空闲端口 |
| `apiKey` | `''` | 网关的 API key；空 = 本地免密模式（默认只用 loopback） |
| `panelPassword` | `admin` | 网关管理面板密码 |
| `claimHour` | `9` | 每日签到触发的本地小时 |
| `quotaPollMs` | `180000` | 模型目录刷新间隔 |
| `statusPollMs` | `20000` | 状态刷新间隔 |
| `autoImport` | `true` | 启动时自动导入本机客户端凭据 |

环境变量覆盖：`DSH_QODER_PYTHON`、`DSH_QODER_PORT`、`DSH_QODER_STATUS_POLL_MS`、`DSH_QODER_MODELS_POLL_MS`。

数据落在 `~/.dsh/qoder2api-hub/`（账号、用量、调度器状态）。

## 状态卡片

设置页卡片展示：

- **登录态**：每个账号的 uid、昵称、区域、套餐、token 剩余有效天数、是否需要刷新
- **积分余额**：总额 + 按区域（intl / cn）+ 按账号，含分包明细
- **签到**：最近一次签到的逐账号结果与累计新增积分，以及调度器最近日志
- **模型**：可用模型列表，含上下文窗口、是否免费、可用的思考档位

状态接口：`GET /plugins/dsh-qoder2api-hub/status`（仅 loopback），另有 `POST /checkin`、`POST /refresh`、`POST /restart`。

## 工作原理

```
DSH 请求
  └─ hub adapter（pi-ai openai-completions）
       └─ loopback shim（随机 token，127.0.0.1）      ← 校验 host/origin/authorization
            └─ Python 网关 qoder_proxy.py（127.0.0.1）
                 └─ Qoder 上游 api2-v2.qoder.sh / gateway.qoder.com.cn
```

分工是刻意的：**全部 Qoder 协议细节**（COSY 签名、客户端身份头、凭据解密、模型目录解析、调度与签到、错误码归一）都由 vendored 网关负责；插件本体只管 DSH 集成——拉起并监管 Python 进程、在其前面套一层 loopback shim、注册 llm adapter、暴露状态卡片数据。

两点实现细节值得单独说明：

**思考程度透传**：插件为每个模型生成一个**恒等映射**的 `thinkingLevelMap`（每个档位映射到自身）。pi-ai 在真正发请求前会用这张表把 `params.reasoning_effort` 解析成上游档位名，恒等映射保证客户端选的档位一字节不改地到达上游。

**工具定义形状**：DSH 交给 adapter 的工具是扁平描述符 `{name, description, parameters}`，而多数 OpenAI 兼容上游只认标准形状 `{type:'function', function:{...}}`。插件在 `/v1/chat/completions` 与 `/v1/responses` 两条路径上做形状转换，其余请求体原样透传。响应侧不需要反向转换——上游回流的本来就是标准 `delta.tool_calls` 增量。

## 排障

**状态显示 "needs Python 3.9+"**
机器上没有 3.9+ 解释器，或自动发现没找到。用 `DSH_QODER_PYTHON` 显式指定。

**账号数 0 / 提示 credential not found**
Qoder 客户端没登录过。打开客户端登录一次，再在卡片上点刷新。

**模型调用返回 401 / 403**
凭据过期。打开 Qoder 客户端一次即可刷新 `auth.v1.dat`，或者让网关的保活任务跑到下一个整点。

**状态是 signed-out 但客户端明明登录着**
插件读的是客户端的 `auth.v1.dat`，读不到时会退回读插件自己保存的凭据副本。确认插件对客户端数据目录有读权限。

**上游返回队列错误（如 CN 区域 10605）**
这是 Qoder 上游的真实限流，不是插件缺陷。换账号或稍后重试。

**某个模型流式响应中断（`TypeError: terminated`）**
上游在内层信封里塞了非对象的 JSON 字面量（例如 MiniMax 系列会发 `"null"`）。网关已加守卫，遇到这种情况原样透传而不是崩掉。若复现，请附上网关 stderr 里的 Python traceback。

## 开发

```powershell
node test/e2e.mjs
```

端到端测试覆盖：Python 发现、网关生命周期、本机凭据扫描、账号导入、模型目录、积分、签到、真实推理、思考程度透传、流式、空帧守卫、拆除。测试打的是真实 Qoder 上游，需要本机已登录。

## 许可

MIT。vendored 网关沿用其上游许可。
