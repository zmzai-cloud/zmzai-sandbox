# 环境变量参考

所有变量都是 Sandbox 服务端变量。浏览器不会收到 Relay 凭据、OpenSandbox API Key 或这些配置。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `AUTH_URL` | `https://auth.zmzai.cloud` | 登录会话校验服务地址 |
| `RELAY_URL` | `https://m.zmzai.cloud/api/v1` | 统一模型 Relay 的 API 前缀 |
| `RELAY_INTERNAL_URL` | 从 `RELAY_URL` 推导 | Relay 私网地址，用于解析 `sandbox_key` 和内部模型调用 |
| `RELAY_SANDBOX_SERVICE_SECRET_CURRENT` | 无 | Relay 与 Sandbox 共享的服务端密钥；生产必须配置 |
| `OPEN_SANDBOX_URL` | 无 | OpenSandbox Server 的私有基础 URL；未设置时使用 demo provider |
| `OPEN_SANDBOX_API_KEY` | 无 | 调用 OpenSandbox 生命周期 API 的服务端密钥 |
| `OPEN_SANDBOX_PROTOCOL` | `http` | Execd endpoint 为主机名/IP 时使用的协议 |
| `OPEN_SANDBOX_IMAGE` | `node:22-alpine` | 执行镜像。生产已构建 `zmzai-agent-python:1`（node + python3 + python-pptx/pytest + tsx + 基础工具，见 `docker/agent-python.Dockerfile`） |
| `OPEN_SANDBOX_CPU_LIMIT` | `500m` | 每个临时沙箱的 CPU 限制 |
| `OPEN_SANDBOX_MEMORY_LIMIT` | `512Mi` | 每个临时沙箱的内存限制 |
| `SANDBOX_AGENT_SERVICE_SECRET_CURRENT` | 无 | a.zmzai.cloud 调用内部 Agent API 的服务密钥；生产必须配置 |
| `SANDBOX_AGENT_SERVICE_SECRET_PREVIOUS` | 空 | 轮换期间的旧服务密钥 |
| `SANDBOX_AGENT_ALLOWED_PROGRAMS` | 内置白名单 | exec 工具允许的程序白名单（逗号分隔，覆盖默认列表） |
| `SANDBOX_RUN_TTL_HOURS` | `24` | 控制台/开发者运行在 Mongo 中的归档保留时长（小时）。`0` 表示不持久化，仅保存在进程内存 |
| `SANDBOX_MAX_PLAN_STEPS` | `3` | Agent 多轮规划的最大执行步数（1 到 8）；达到上限后由模型已有的输出作为最终结论 |

## 安全要求

- 只在服务端设置这些变量；不要使用 `NEXT_PUBLIC_` 前缀；
- `OPEN_SANDBOX_URL` 应指向 `127.0.0.1` 或私网地址，不要直接放到公网；
- API Key 用密钥管理或权限为 `0600` 的文件注入；
- 镜像应使用固定、可审计的 tag。当前 `node:22-alpine` 是初始默认，不代表允许用户任意选择镜像；
- 修改 CPU、内存或网络策略前，先同步更新运行策略和容量评估文档。

## 本地启动

```bash
cp .env.example .env.local
pnpm install
pnpm dev
```

没有 `OPEN_SANDBOX_URL` 时可启动页面和 demo provider；要验证真实执行，必须配置可访问的 OpenSandbox Server 和对应 API Key。
