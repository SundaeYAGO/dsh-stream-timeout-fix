# dsh-stream-timeout-fix

[English](https://github.com/SundaeYAGO/dsh-stream-timeout-fix/blob/main/README.md) · **简体中文**

[![CI](https://github.com/SundaeYAGO/dsh-stream-timeout-fix/actions/workflows/ci.yml/badge.svg)](https://github.com/SundaeYAGO/dsh-stream-timeout-fix/actions/workflows/ci.yml)

> 本文与英文版内容保持一致；如两版出现出入，**以英文版为准**。

一个极小的 **DeepSeek Harness（DSH）** 宿主侧插件：阻止 Node 内置 `fetch` 掐死
「长时间静默的 LLM 流」——那些在流中途静默约 **304–305 秒**后死于

```
TypeError: terminated        (cause: BodyTimeoutError, UND_ERR_BODY_TIMEOUT)
```

并被归类为 `TRANSPORT` 失败的请求。**而平台侧其实从未挂断我们。**

> **适用场景**：面向「响应时间长、且偶尔在流中途停顿」的**第三方 / 自建
> OpenAI 兼容端点**——例如学校、公司的私有化部署，LiteLLM 之类的网关，
> 自托管 vLLM 等。如果你用的是行为良好的大型云 API，大概不需要它。
>
> **维护声明**：作者出于**自用目的**编写，顺手开源给可能遇到同样问题的人。
> **不保证持续维护**——issue / PR 可能不会及时处理，也没有任何支持承诺。
> 插件本体约 120 行，安装前请自行过一遍代码。实际观测到的范围见下文「验证状态」。
>
> **尚未发布到 npm**：`dsh-stream-timeout-fix` 目前不在 npm registry 上，
> 请先从本仓库安装——见[安装](#安装)一节。

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

## 验证状态（信任它之前请先读）

本插件是**先诊断、后编写**的：它由受控的本地复现 + 自带测试套件证明，
而**不是**由真实场景证明的：

* **本地已复现**：流在中途静默后，会在「最后字节 + 约 304 秒」处被 undici 默认时钟
  以 `TypeError: terminated`（`UND_ERR_BODY_TIMEOUT`）杀掉；换成插件的 Agent 后，
  同样的静默能正常读完（见 `npm test`、`scripts/reproduce-300s.mjs`）。
* **指纹吻合**：促成这个插件的每一次线上失败，静默间隔都是 304.6–305.4 秒、
  `message: "terminated"`，且都发生在内容开始之后、从不在响应头阶段。
* **现场数据（2026-10-13 → 2026-10-18）**：11 个会话里共 19 次记录在案的失败
  （按 `stream finish` 事件结构统计，不是按日志文本），**目标失败类一次都没有复现**——
  即 `TRANSPORT` 且 cause 链为 `TypeError: terminated` → `BodyTimeoutError`
  （`UND_ERR_BODY_TIMEOUT`）。剩下的全是 AUTH / `SERVER 503` / `INVALID_REQUEST 404` /
  `EMPTY_RESPONSE`，以及下一条说的新墙。
* **剩下的 300 秒墙属于 DSH，不属于 undici**。2026-10-18 有两次尝试分别在
  **300.02 秒**与 **300.04 秒**被 `pi-ai stream idle timeout after 300000ms`
  （`code: TIMEOUT`）切断——而此时本插件的 undici 上限已经是 30 分钟。原因：那条路由
  没有设置 `streamIdleTimeoutMs`，走默认 `300000`。所以**在把它调大之前，静默上限仍然是
  300 秒**（见「同时调大 `streamIdleTimeoutMs`」）。好处是：错误码从此是诚实的
  `TIMEOUT`，不再是误导性的 `TRANSPORT`。
* **仍不是"亲眼看到它挺过去"——但现在是测量出来的，不是猜的**。有两条长请求完成了，
  却都**没有真正停顿**：
  * **2026-10-18，314.23 秒**（输入 438,236 / 输出 3,791）：最长静默 **约 210 秒**，
    仍低于旧上限；
  * **2026-10-19，756.84 秒**（输入 512,276 / 输出 17,083，含 9,006 个逐字时间戳）：
    首字 **91.2 秒**后才到，随后**最大分片间隔只有 2.6 秒**——这是一次持续吐字
    12.6 分钟的长生成。长，但没有 stall，所以**同样不是证据**。

  对**本机全部会话的 9,724 次尝试**做完整审计：**没有任何一次出现过 ≥300 秒的分片间隔**。
  历史最长静默是 **277.0 秒**（2026-10-12，**装插件之前**，且成功），而修复前的 9 次失败
  死在 **304.6–305.4 秒**——这两个数字几乎正好把 undici 的 300 秒默认值夹在中间，
  机制从两侧都得到了印证。

  所以验收测试仍未达成：需要**一次 >300 秒的静默间隔**端到端跑完，而这同时要求把
  `streamIdleTimeoutMs` 调大（见「同时调大 `streamIdleTimeoutMs`」）。一条命令即可回答：

  ```bash
  node scripts/audit-session-gaps.mjs ~/.dsh/sessions --min-gap-s=250
  # -> 按最大分片间隔列出各次尝试，并统计有多少次达到 >= 300 秒
  ```

若某个请求在长静默中仍然失败，请对比间隔长度：**304–305 秒**指向栈里某个 undici 默认
时钟；**恰好 300 秒**且报 `pi-ai stream idle timeout` 指向 DSH 自己的看门狗；
其他数值则指向服务端/网关的空闲上限——那不在本插件能解决的范围内。

## 安装

> **尚未发布到 npm。** 本包还没有发布到 npm registry，因此
> `npm install dsh-stream-timeout-fix`（以及
> `dsh plugin … add dsh-stream-timeout-fix`）目前会 404。
> 请先用下面的「从本仓库安装」；npm 方式在首次发布之后才可用。

**要求 Node ≥ 22.19**——这是 `undici` 依赖的 engines 约束（`engines.node >= 22.19.0`）。
任何能挂载本插件的 DSH 版本本身就内置了 undici 8.x，因此这与真实部署范围一致；
在 Node 20 上导入会直接失败，而不是悄悄行为异常。

### 从本仓库安装（现在就能用）

```bash
git clone https://github.com/SundaeYAGO/dsh-stream-timeout-fix
cd dsh-stream-timeout-fix
npm install     # 装上插件 import 的 undici 依赖
```

然后把这份 checkout 作为本地 bundle 挂进 profile：

1. 在 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 里加
   `"dsh-stream-timeout-fix": "link:<checkout 的绝对路径>"`；
2. 把 `"dsh-stream-timeout-fix"` 追加进 `dsh.profile.bundles`；
3. 在 profile 目录执行安装/链接（`pnpm install`，它会建好 `node_modules` 链接），
   然后重启 DSH。

插件自带的 `cordis.patch.yml` 会负责挂载插件行，**无需手改 profile patch**。
如果你的 DSH CLI 接受 git 规格（其它 DSH 插件用的也是这种写法），
`dsh plugin --profile <profile> add github:SundaeYAGO/dsh-stream-timeout-fix`
可以替你完成上面三步。

### 从 npm 安装（首次发布之后）

用 DSH CLI（bundle patch 会自动挂载插件行，**无需手改 profile patch**）：

```bash
dsh plugin --profile <profile-name> add dsh-stream-timeout-fix
```

手动方式（在 profile 目录 `~/.dsh/profiles/<profile>`）：

1. 加依赖：`"dsh-stream-timeout-fix": "^1.0.0"`（然后安装）；
2. 把 `"dsh-stream-timeout-fix"` 追加进 `package.json` 的 `dsh.profile.bundles`。

随后重启 DSH（或看你所用版本是否支持 live bundle 应用——支持时本插件会热挂载）。

## 验证

* loader 里该条目为 enabled/active（`include:stream-timeout-fix`）；
* 宿主日志出现一行激活记录：
  `[stream-timeout-fix] global dispatcher replaced: bodyTimeout=1800000ms, headersTimeout=600000ms ...`
* 运行时标记：`globalThis.__streamTimeoutFix` 保存着装上的 `Agent`、生效超时与运行时版本；
* 真正的证明是被动的：下次供应商出现 300+ 秒 stall 时，请求不再被掐死。
  如果某个请求在长静默中**仍然**失败，看间隔长度——明显偏离 304–305 秒的，
  才是平台/网关自己的空闲上限，而不是这个客户端时钟。

## 配置

| 配置项 | 默认 | 位置 |
|---|---|---|
| `bodyTimeoutMs` | `1800000` | patch 行 `config`，或环境变量 `DSH_STREAM_TIMEOUT_BODY_MS` |
| `headersTimeoutMs` | `600000` | patch 行 `config`，或环境变量 `DSH_STREAM_TIMEOUT_HEADERS_MS` |

设为 `0` 表示彻底关闭该时钟（不建议全局这么做——你会失去回收死 socket 的最后手段）。

## 本插件不做什么

* **不含重试**。它不携带任何重试策略，也从不重发请求。重试属于 DSH 自带的重试插件
  （`@deepseek-ai/dsh-llm-retry`），在 profile patch 里按 provider 配置——想两者都用，
  见下面的搭配示例。
* **不碰 provider / 鉴权 / 路由**：不挂载服务、不注册工具、不接触任何端点或密钥。
* **不做费用控制**：它无法限额、取消或预算——请看下一节。
* **不改服务端**：如果你的网关自己有「空闲即断」的限制，本插件帮不上；
  该向运维方要的是服务端 SSE 注释心跳。
* **不改 DSH 自己的流看门狗**：`streamIdleTimeoutMs` 是「按路由」的配置
  （`dsh-llm-pi-ai`），换 dispatcher 动不了它——见下一节。

## 同时调大 `streamIdleTimeoutMs`（要挺过 300+ 秒静默就必须做）

本插件只摘掉 **undici 的** 300 秒时钟。DSH 自己按路由的看门狗仍会在
`streamIdleTimeoutMs`（默认 `300000`）处切断静默流，报
`pi-ai stream idle timeout after 300000ms`（`code: TIMEOUT`）。

这不是理论：2026-10-18 有两次尝试分别死在 **300.02 秒**与 **300.04 秒**，
而当时本插件已生效（undici 上限已是 30 分钟）——因为那条路由没有设
`streamIdleTimeoutMs`。不调大它，本插件只改善**诊断**（诚实的 `TIMEOUT`
取代误导性的 `TRANSPORT`），并**不会**延长可容忍的静默时长。

```yaml
providers:
  your-provider:
    streamIdleTimeoutMs: 1800000   # 30 分钟——必须大于你想挺过的最长 stall
```

注意 pi-ai 的计时**从请求下发开始，含首个 token 之前的等待**：巨大 prompt 的
慢预填充与流中途停顿消耗的是同一份预算。（和下面的重试策略在同一个 profile
patch 里，只是不同的键。）

## 费用与计费（请务必阅读）

插件本身**不发任何网络请求**，自身不产生费用。但它改变了 stall 的**结果**，
而这是有代价的：

* 修复前：请求在 ~304 秒被杀，你**为压根没收到的 token 付了钱**。
* 修复后：请求会继续等待，而 provider 仍在生成——这些 token 同样会计费。
  你现在为**真正收到**的输出付费，但单次请求可能多花几分钟。
* 若再配上「无限重试」策略，反复 stall 会成倍放大 token 支出
  （多数 provider 对每次失败的尝试也计费）。请据此安排预算、盯住用量面板，
  并尽量缩小单次产出规模。
* 默认时钟是**有限值**（30 分钟 / 10 分钟）而非无限：真死的对端仍会被回收，
  不会永久挂起。

## 与重试策略搭配（可选，本插件不含）

自动重试属于你的 profile patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`），
不属于本插件。示例（某个 provider 路由）：

```yaml
providers:
  your-provider:
    retryPolicy:
      mode: always              # 无重试次数上限；不校验 retryableCodes
      backoff: { initialDelayMs: 5000, maxDelayMs: 300000, jitterRatio: 0.25 }
```

退避间隔要照顾 provider 的速率限制（私有化部署的「每 key RPM」往往很小），
并牢记上一节：**重试是要计费的**。

## 影响面与注意事项

* **按设计是进程级的**：宿主进程里所有 `fetch`（全部 provider、其他插件）都不再受
  300 秒默认上限约束，改用你配置的值。这正是目的，但影响面确实存在。
* **跨版本 dispatcher 的已知报告，我们实测而不是想当然**：上游有多条讨论
  （`#7721`、`#7671`、`#7598`、`#7468`、`#7502`）把「userland undici 8.x 的 dispatcher
  装进进程全局槽位」归咎为 Node 内置 fetch（内置 undici 7.x）丢失 content-encoding
  解压与响应头的原因——那正是本插件动的同一个槽位。`scripts/check-content-encoding.mjs`
  （已并入 `npm test`）在**换 dispatcher 前后**各验一次 gzip 解码；在 Node 24.21 +
  undici 8.11.2 上通过。若安装后真的遇到裸 gzip/brotli 或响应头异常，请先停用本插件，
  并附上 `node -v` 与 `process.versions.undici` 一起反馈。
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

## 出处（Provenance）

**纯 vibe coding 产物**：调研与实现由 **GLM 5.3** 与 **DeepSeek V4.1 Flash** 驱动完成。
README 里的每条结论背后都有本仓库可跑的脚本（`npm test`、`scripts/reproduce-300s.mjs`）
——请自己跑一遍，而不是相信文字。完整说明见
[PROVENANCE.md](https://github.com/SundaeYAGO/dsh-stream-timeout-fix/blob/main/PROVENANCE.md)
（模型出处放在 `LICENSE` 之外，是为了让 GitHub 能正确识别 MIT 许可）。

## 更新日志

见 [CHANGELOG.md](https://github.com/SundaeYAGO/dsh-stream-timeout-fix/blob/main/CHANGELOG.md)。

## 许可

MIT。`undici` 是普通依赖（未内联打包），其许可证随它自己分发。
