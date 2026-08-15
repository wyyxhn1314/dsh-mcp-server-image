# dsh-mcp-server-image

通用 OpenAI 兼容文生图 MCP 服务器（stdio）。把任意 `POST {baseURL}/images/generations`
端点（OpenAI Images API 形态：`gpt-image-*`、`dall-e-*`，或任何兼容中转站/网关）
包装成一个 MCP 工具 `generate_image`，供 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
（或任何 MCP 客户端）调用。

零依赖：纯 Node（`fetch`）+ JSON-RPC 2.0 over stdio。

## 安装与使用（DeepSeek Harness）

DSH 通过官方 `@deepseek-ai/dsh-mcp-client` 桥接本服务器：

```bash
dsh plugin --profile web add @deepseek-ai/dsh-mcp-client
```

在你的 profile `cordis.patch.yml` 追加一个实例（密钥走环境变量，不落盘配置）：

```yaml
- insert:
    - id: mcp-image
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: image
        transport: stdio
        command: npx
        args:
          - '-y'
          - 'dsh-mcp-server-image'
          - '--base-url'
          - 'https://api.openai.com/v1'
          - '--model'
          - 'gpt-image-1'
        env:
          IMAGE_API_KEY: !!js process.env.IMAGE_API_KEY
```

然后模型就获得 `mcp__image__generate_image` 工具，对模型说「生成一张 xxx 的图片」即可。
生成的 https 图片 URL 直接以 markdown `![alt](url)` 渲染在聊天里；同时默认在
`$DSH_HOME/generated/` 保存持久副本（URL 可能有时效）。

### 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--base-url` | `https://api.openai.com/v1` | OpenAI 兼容 base URL（不含 `/images/generations`） |
| `--model` | `gpt-image-1` | 生图模型 id（如 `gpt-image-2`、`dall-e-3`） |
| `--key-env` | `IMAGE_API_KEY` | 存放 API key 的环境变量名 |
| `--out-dir` | `$DSH_HOME/generated` 或 `./generated` | 持久副本目录 |
| `--no-save` | — | 不下载持久副本 |

工具入参：`prompt`（必填）、`size`（`1024x1024` / `1024x1536` / `1536x1024` / `512x512` / `auto`）、
`n`（1–4）、`save`（默认 true）。

### 网络与代理

直连可用时无需任何设置。若你的网络需要代理（如国内访问外网），按 Node 标准
环境代理机制配置：

```yaml
env:
  NODE_USE_ENV_PROXY: '1'
  HTTPS_PROXY: 'http://127.0.0.1:7890'
  HTTP_PROXY: 'http://127.0.0.1:7890'
```

## 行为细节

- 请求默认带 `response_format: "url"`；端点不支持时自动回退（不带该字段重试），
  并在仅有 `b64_json` 时解码落盘。
- API key 只从环境变量读取，绝不进入任何配置文件。
- 图片默认落盘 `$DSH_HOME/generated/`（`.png`/`.jpg`/`.webp` 按内容类型识别）。
- 超时：生图请求 180s，副本下载 60s。

## 独立使用（任意 MCP 客户端）

```bash
IMAGE_API_KEY=sk-xxx npx -y dsh-mcp-server-image \
  --base-url https://api.openai.com/v1 --model gpt-image-1
```

## 许可

MIT
