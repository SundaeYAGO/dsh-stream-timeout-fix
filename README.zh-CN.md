# dsh-bundle-undici-clockfix

一个极小的 **DeepSeek Harness（DSH）** 宿主侧插件：阻止 Node 内置 `fetch` 掐死
「长时间静默的 LLM 流」——那些在流中途静默约 **304–305 秒**后死于

```
TypeError: terminated        (cause: BodyTimeoutError, UND_ERR_BODY_TIMEOUT)
```

并被归类为 `TRANSPORT` 失败的请求。**而平台侧其实从未挂断我们。**

---

## 现象

流式 LLM 端点偶尔这样失败：

* SSE 响应**已经建立、内容已经开始吐**（推理 token、部分答案、工具调用增量），然后
* **几分钟没有任何字节**（上游仍在生成），接着
* 本地在静默约 304–305 秒后报 `TypeError: terminated`，被当成传输/网络错误。

而平台侧日志显示的恰好相反：它记录的是**客户端主动断开**（LiteLLM / nginx 记 `499`），
上游**继续生成完并照常计费**——你为压根没收到的那部分 token 付了钱。

## 根因

Node 内置 `fetch` 跑在 [undici](https://github.com/nodejs/undici) 上，它自带两个**不触发
就完全看不见**的客户端时钟：

| 时钟 | 默认值 | 作用范围 | 触发时的报错 |
|---|---|---|---|
| `headersTimeout` | `300_000 ms` | 等响应第一个字节 | `TypeError: fetch failed`，cause `HeadersTimeoutError`（`UND_ERR_HEADERS_TIMEOUT`） |
| `bodyTimeout` | `300_000 ms` | 响应体**相邻字节之间**的空闲（每收到一个字节重新计时） | `TypeError: terminated`，cause `BodyTimeoutError`（`UND_ERR_BODY_TIMEOUT`） |

因为 `bodyTimeout` 按字节重新武装，正常「慢但在流」的请求永远不受影响（跑 20 分钟也没事）；
它只在**静默间隔**超过 300 秒时动手——正是上游 stall 的样子。

两点让它极难被正确归因：

1. `bodyTimeout` 把自己报成 **`terminated`**，字面意思就是「对端断开了」，
   没有任何线索指向客户端自己的时钟；
2. DSH 的失败分类器匹配 `/terminated/` 并归类为 `TRANSPORT`（见 `dsh-llm-pi-ai`），
   读起来就像网络/供应商问题。

于是所有可观察事实（平台日志里的客户端断开、`499`、上游生成成功、我们这侧的
`TRANSPORT`）都指向「平台在 ~300 秒处掐空闲连接」——而真凶是我们自己的默认值。

## 这个插件做什么

DSH 的 LLM 调用链从不传自定义 `fetch`
（`dsh-llm-pi-ai` → `pi-ai` → OpenAI SDK v6 → `globalThis.fetch` → **全局 undici
dispatcher**），所以一次进程级替换就能覆盖所有 provider：

```js
setGlobalDispatcher(new Agent({ bodyTimeout: 1_800_000, headersTimeout: 600_000 }))
```

* 默认 `bodyTimeout = 30 分钟`、`headersTimeout = 10 分钟`——**故意取有限值**，
  真死的连接终究会被回收。
* 流层看门狗（如 pi-ai 的 `streamIdleTimeoutMs`）与供应商重试策略仍是真正的兜底；
  本插件只是消除**两个空闲时钟之间的口径分歧**。
* 跨版本注入没问题：全局 dispatcher 存在进程级的
  `Symbol.for('undici.globalDispatcher.1')` 槽里，所以 undici 8.x 创建的 `Agent`
  会被 Node 内置 `fetch`（undici 7.x）认账。

## 安装

用 DSH CLI（bundle patch 会自动挂载插件行，**无需手改 profile patch**）：

```bash
dsh plugin --profile <profile-name> add dsh-bundle-undici-clockfix
```

手动方式（在 profile 目录 `~/.dsh/profiles/<profile>`）：

1. 加依赖：`"dsh-bundle-undici-clockfix": "^1.0.0"`（然后安装）；
2. 把 `"dsh-bundle-undici-clockfix"` 追加进 `package.json` 的 `dsh.profile.bundles`。

随后重启 DSH（或看你所用版本是否支持 live bundle 应用——支持时本插件会热挂载）。

## 验证

* loader 里该条目为 enabled/active（`include:undici-clockfix`）；
* 宿主日志出现一行激活记录：
  `[undici-clockfix] global dispatcher replaced: bodyTimeout=1800000ms, headersTimeout=600000ms ...`
* 运行时标记：`globalThis.__undiciClockfix` 保存着装上的 `Agent`、生效超时与运行时版本；
* 真正的证明是被动的：下次供应商出现 300+ 秒 stall 时，请求不再被掐死。
  如果某个请求在长静默中**仍然**失败，看间隔长度——明显偏离 304–305 秒的，
  才是平台/网关自己的空闲上限，而不是这个客户端时钟。

## 配置

| 配置项 | 默认 | 位置 |
|---|---|---|
| `bodyTimeoutMs` | `1800000` | patch 行 `config`，或环境变量 `DSH_UNDICI_BODY_TIMEOUT_MS` |
| `headersTimeoutMs` | `600000` | patch 行 `config`，或环境变量 `DSH_UNDICI_HEADERS_TIMEOUT_MS` |

设为 `0` 表示彻底关闭该时钟（不建议全局这么做——你会失去回收死 socket 的最后手段）。

## 影响面与注意事项

* **按设计是进程级的**：宿主进程里所有 `fetch`（全部 provider、其他插件）都不再受
  300 秒默认上限约束，改用你配置的值。这正是目的，但影响面确实存在。
* **治不了上游 stall**：供应商若停顿数分钟，请求就得等数分钟。请配合重试策略，
  并尽量让单次产出小一些，降低 stall 的代价。
* **客户端保活不存在**：HTTP/1.1 下 POST 请求体发完后，客户端在该请求上没有任何
  合法写入位置，且 SSE 是单向的（服务器 → 客户端）。TCP keepalive 与 HTTP/2 PING
  只对「传输层空闲」的中间设备有意义。唯一合法的流内心跳是**服务端发的 SSE 注释**
  （`: ping`）——那是服务端措施。本插件是客户端侧的修法。
* 仅适用于 Node。对 Python/Go/Rust 客户端无效——它们没有这个默认值
  （这正好解释了为什么同事「单请求能跑 700 秒」而你不能）。

## 它是怎么被查出来的

1. 一次非流式探测在 **t = 304.6 s** 死于 `HeadersTimeoutError`——
   这是 **undici 的异常类**，由此暴露了客户端时钟的存在。
2. 回查全部生产失败：静默间隔 **304.6–305.4 s**、`message: "terminated"`、
   全部发生在流中途、且都在内容开始之后。
3. 本地受控复现（本地 SSE 服务器 + 真实 Node fetch）精确复刻指纹：
   最后字节在 `t = 2.045 s` → 报错在 `t = 306.062 s`
   （`TypeError: terminated`，cause `BodyTimeoutError`，code `UND_ERR_BODY_TIMEOUT`）；
   而用 `Agent({ bodyTimeout: 0 })` 构造的客户端**挺过 338 秒静默**并把流读完。
   用另一版本 undici 的 `setGlobalDispatcher` 也能修好内置 `fetch`——正是本插件用的注入路径。

仓库自带该复现脚本：

```bash
node scripts/reproduce-300s.mjs            # 默认 fetch：复现 ~304 秒被杀
node scripts/reproduce-300s.mjs --plugin   # 装上本插件后：挺过 300 秒
```

## 开发

```bash
npm install
npm test
```

`npm test` 跑一组快速、确定性的对照：

* **对照**——一个 `bodyTimeout` 极小的 `Agent` 证明静默流会死于
  `UND_ERR_BODY_TIMEOUT`（即线上失败的形状）；
* **修复**——`apply()` 之后同样的静默能读完，且全局 dispatcher 确实是本插件的 agent；
* 外加响应头阶段存活与重复挂载幂等两项检查。

## 许可

MIT。`undici` 是普通依赖（未内联打包），其许可证随它自己分发。
