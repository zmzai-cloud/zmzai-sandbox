# HTTP 与 SSE API 参考

Base URL：`https://z.zmzai.cloud`。当前接口使用浏览器登录会话 Cookie，不接受用户提交的模型 API Key。

## 开发者预览：`sandbox_key`

登录后在 [开发者工作台](https://z.zmzai.cloud/developers) 创建 `zsk_...`。它只能调用 Sandbox Runner，不能直接调用 Relay 的 `/api/v1/chat/completions` 或 `/api/v1/models`。

```bash
curl https://z.zmzai.cloud/api/v1/runs \
  -H "Authorization: Bearer zsk_..." \
  -H "Idempotency-Key: <16-128-character-unique-value>" \
  -H "Content-Type: application/json" \
  -d '{"task":"计算 1+1 并输出结果","model":"<model-id>"}'
```

`GET /api/v1/runs/:runId`、`GET /api/v1/runs/:runId/events` 和 `POST /api/v1/runs/:runId/cancel` 使用同一 `Authorization`。运行与幂等记录持久化在 Mongo 中（默认保留 24 小时，`SANDBOX_RUN_TTL_HOURS` 可调），但运行事件和产物字节仍在进程内存中，服务重启后事件流不再可回放；不要把它当作持久化 SDK 承诺。

### 多轮规划

`sandbox_key` 提交的任务由 Agent 多轮执行：每轮规划一条命令并运行，stdout/stderr 作为观察回传给模型，由其决定继续执行（最多 `SANDBOX_MAX_PLAN_STEPS` 轮，默认 3）或给出最终结论。事件流中的 `sandbox.step` 事件标识每一步的进度；中途某步失败则整个运行立即终止，已产生的步骤事件保留。

## `POST /api/v1/exec`

直接在临时沙箱中执行一段代码，**不经过 LLM 规划**。适合确定性计算、数据处理等已经明确要跑什么代码的场景。

请求：

```json
{
  "language": "javascript | python | shell",
  "code": "console.log(6 * 7)",
  "timeoutMs": 30000,
  "inputFiles": [{ "path": "data/input.csv", "content": "a,b\n1,2" }],
  "limits": { "cpuMillis": 500, "memoryMiB": 512 }
}
```

限制：`code` 1 到 12000 字符；`timeoutMs` 1000 到 60000（默认 30000）；`inputFiles` 最多 50 个文件、总量不超过 1 MiB，路径不允许绝对路径或 `..`；`limits.cpuMillis` 100 到 4000、`limits.memoryMiB` 128 到 2048。需要唯一的 `Idempotency-Key`（16 到 128 个可打印字符）。

成功返回 `201` 和 `{ "run": ... }`，`run.model` 为 `"direct"`。查询、SSE 事件流和取消复用 `GET /api/v1/runs/:runId`、`GET /api/v1/runs/:runId/events`、`POST /api/v1/runs/:runId/cancel`。并发与幂等限制与 `POST /api/v1/runs` 相同。

错误码：`SANDBOX_KEY_INVALID`（401）、`INVALID_BODY`（400）、`INVALID_IDEMPOTENCY_KEY`（400）、`IDEMPOTENCY_CONFLICT`（409）、`RATE_LIMITED`（429，附 `Retry-After`）。

## `GET /api/v1/runs/:runId/artifacts/:path`

下载运行产出的文件。`path` 必须出现在运行 `deliverables` 清单中；成功返回文件字节（`attachment`），`tooLarge` 的文件、字节已随服务重启清理或路径不在清单中时返回 `404`。

## `GET /api/session`

读取当前登录用户。

成功 `200`：

```json
{"user":{"id":"user_123","name":"牧之","email":"user@example.com","role":"user"}}
```

未登录 `401`：

```json
{"user":null,"loginUrl":"https://auth.zmzai.cloud/login"}
```

## `GET /api/models`

读取当前用户通过 Relay 可用的模型。Sandbox 服务端会把会话 Cookie 转发给 `m.zmzai.cloud/api/v1/models`。

成功响应由 Relay 返回，至少包含模型的 `id` 和展示信息。未登录为 `401`，Relay 不可用通常为 `503`。不要缓存为全局静态模型列表。

## `POST /api/runs`

创建一次 Agent 运行。

请求：

```json
{"task":"计算 1+1 并输出结果","model":"<model-id>"}
```

限制：`task` 3 到 2000 字符；`model` 必填，且应来自当前用户的模型目录。成功返回 `201` 和 `{ "run": ... }`。未登录为 `401`，参数错误为 `400`，Relay 错误或 OpenSandbox 错误会在运行事件和终态中体现。

运行对象当前形状：

```json
{
  "id":"run_abc12345",
  "userId":"user_123",
  "task":"计算 1+1 并输出结果",
  "model":"model-id",
  "status":"queued|running|succeeded|failed|cancelled",
  "createdAt":"2026-08-07T00:00:00.000Z",
  "startedAt":"2026-08-07T00:00:00.000Z",
  "finishedAt":"2026-08-07T00:00:01.000Z",
  "exitCode":0,
  "provider":"opensandbox",
  "events":[],
  "artifacts":[]
}
```

`userId` 只用于服务端归属校验，客户端不要据此实现授权。

## `GET /api/runs`

返回当前登录用户的运行列表：进程内存中的活跃运行 + Mongo 归档历史（`archived: true`，只读——产物字节与事件已随进程清理，不支持取消），按 `createdAt` 倒序合并去重。归档保留时长由 `SANDBOX_RUN_TTL_HOURS` 控制。

## `GET /api/runs/:runId`

返回属于当前用户的单次运行。内存未命中时回退到 Mongo 归档（`archived: true`，只读）。不存在或不属于当前用户时返回 `404`。

## `GET /api/runs/:runId/events`

以 `text/event-stream` 返回事件。每条消息格式为：

```text
data: {"run":{"id":"run_abc12345","status":"running","events":[...]}}

```

事件 `kind` 为 `system`、`stdout`、`stderr`、`status` 或 `artifact`。运行进入 `succeeded`、`failed` 或 `cancelled` 后连接关闭。客户端应允许重连并以 `GET /api/runs/:runId` 重新同步状态。

## `POST /api/runs/:runId/cancel`

请求取消当前用户的运行，返回 `{ "run": ... }`。当前实现先更新运行状态，不保证已经发出的 Execd 命令立即停止，见接入指南中的限制。

## `GET /api/provider`

服务端 OpenSandbox 健康检查。配置后成功返回：

```json
{"provider":"opensandbox","configured":true,"healthy":true,"baseUrl":"http://127.0.0.1:8080"}
```

该端点不应公开 OpenSandbox API Key。若控制面不可用则返回 `503`。

## 错误处理

客户端应按 HTTP 状态和运行终态双重处理：`401` 重新登录，`402` 引导用户到 Relay 余额页面，`400` 修正输入，`404` 丢弃失效 run id，`503` 做有限重试并提示服务暂不可用。不要把错误消息当作可执行命令。
