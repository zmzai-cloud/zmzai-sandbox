# Sandbox · zmzai.cloud

`z.zmzai.cloud` 是 ZMZ AI 的受限代码执行层。

它给 Agent 和开发者提供一个临时、可控、可审计的执行环境。用户不需要接触模型 API Key；模型调用和额度结算由 Relay 负责，代码执行由 Sandbox Runner 负责。

## 职责

- 接收自然语言任务或结构化执行请求；
- 通过 Relay 获取用户可用模型并完成规划；
- 将规划结果限制为经过校验的 `run_code` 命令；
- 在私有 OpenSandbox 中创建临时执行环境；
- 通过 SSE 返回 stdout、stderr 和状态事件；
- 为 `a.zmzai.cloud` 提供内部 Agent Runner API；
- 支持开发者创建 `sandbox_key` 并调用 `POST /api/v1/runs`。

## 当前边界

- 当前是 Runner 和控制台验证闭环，不是稳定第三方 SDK；
- 消费者运行记录保存在进程内存中，Mongo 镜像保留 1 小时 TTL；
- 单次运行只支持一个 `run_code` 工具调用；
- OpenSandbox 只应监听回环地址或私网地址，不应直接暴露公网；
- 当前 Docker `runc` 部署不能被描述为 VM、gVisor 或强多租户隔离。

## 从这里开始

- [文档总览](docs/README.md)
- [第一次执行：让 Agent 在沙箱中回答 `1+1`](docs/tutorials/first-authenticated-run.md)
- [接入 ZMZ AI Agent](docs/how-to/integrate-agent.md)
- [HTTP 与 SSE API 参考](docs/reference/http-api.md)
- [环境变量参考](docs/reference/configuration.md)
- [认证、Relay 与沙箱边界](docs/explanation/trust-boundaries.md)
- [线上开发者工作台](https://z.zmzai.cloud/developers)

## 目录

| 路径 | 说明 |
| --- | --- |
| `app/developers/` | 开发者工作台 |
| `components/developer-workbench.tsx` | 控制台主界面 |
| `lib/agent-api.ts` | 内部 Agent Runner API |
| `lib/agent-auth.ts` | 服务密钥鉴权 |
| `lib/agent-executor.ts` | Agent 请求执行入口 |
| `lib/agent-planner.ts` | LLM 规划为结构化命令 |
| `lib/opensandbox-provider.ts` | OpenSandbox 生命周期调用 |
| `lib/relay-client.ts` | Relay 模型与 key 校验调用 |
| `docs/` | 教程、how-to、参考和边界说明 |
| `docker/agent-python.Dockerfile` | 生产执行镜像 |

## 本地运行

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

常用检查：

```bash
pnpm typecheck
pnpm test
```

没有 `OPEN_SANDBOX_URL` 时可以启动页面和 demo provider。要验证真实执行，需要配置可访问的 OpenSandbox Server 和对应 API Key。

完整部署和排错步骤见 [自建 OpenSandbox](docs/how-to/self-host-opensandbox.md)。

Apache-2.0 · 牧之
