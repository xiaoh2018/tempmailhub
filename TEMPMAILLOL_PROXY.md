# Tempmail.lol 代理机制说明

## 目的

`Tempmail.lol` 免费层可能会对服务端 IP 触发风控、验证码或频率限制。

TempMailHub 现在的优先顺序改为：

1. 如果配置了 `TEMPMAILLOL_PROXY_BASE_URL`，先走你的自有代理
2. 自有代理不通时，最后再尝试一次 `CodeTabs`
3. 如果没有配置 `TEMPMAILLOL_PROXY_BASE_URL`，才回退到“直连 -> CodeTabs”

## 当前后端逻辑

`src/providers/tempmail-lol.ts` 中的逻辑如下：

- 配置了 `TEMPMAILLOL_PROXY_BASE_URL`：
- 先请求自有代理
- 自有代理失败后再试 `CodeTabs`
- 没有配置 `TEMPMAILLOL_PROXY_BASE_URL`：
- 先直连上游
- 直连失败后再试 `CodeTabs`
- 以下情况会触发回退：
- HTTP `403`
- HTTP `429`
- 无响应 / 网络错误
- 响应体出现 `captcha_required`
- 响应体出现 `banned` / `abuse` / `limit` / `required`

如果你已经配置了自有代理，后端不会优先直连 `Tempmail.lol` 上游。

## 代理服务接口约定

后端要求代理服务实现与上游一致的两个路径：

- `POST /v2/inbox/create`
- `GET /v2/inbox?token=...`

也就是说，如果你的代理地址是：

```text
https://proxy.example.com
```

那么后端回退时会请求：

```text
https://proxy.example.com/v2/inbox/create
https://proxy.example.com/v2/inbox?token=...
```

## 环境变量

### `TEMPMAILLOL_PROXY_BASE_URL`

你的自有代理服务根地址，例如：

```text
https://proxy.example.com
```

### `TEMPMAILLOL_PROXY_SHARED_TOKEN`

可选。用于后端访问你的代理服务时附带鉴权头：

```http
X-Proxy-Token: your-shared-token
```

如果你在代理服务端校验这个头，可以避免被别人滥用你的代理地址。

## Cloudflare Worker 示例

仓库中提供了一个最小可用示例：

- `examples/tempmail-lol-proxy-worker.js`

它具备这些特点：

- 只放行 `Tempmail.lol` 所需的两个路径
- 可选校验 `X-Proxy-Token`
- 可选给上游附带 `TEMPMAILLOL_API_KEY`
- 返回浏览器可用的 CORS 响应

## 推荐部署方式

### 方案 A：自建 Worker 代理

适合：

- 你已经有 Cloudflare 账户
- 想快速上线
- 想限制只代理 `Tempmail.lol` 这一类请求

建议变量：

- `ALLOWED_ORIGIN`
- `PROXY_SHARED_TOKEN`
- `TEMPMAILLOL_API_KEY`（如果你有官方付费 key）

### 方案 B：自建反向代理域名

适合：

- 你已有自己的服务端
- 想统一接入更多临时邮箱渠道
- 想自己做频率控制、日志和安全校验

## 后端配置示例

### Node.js / 本地

```bash
export TEMPMAILLOL_PROXY_BASE_URL="https://proxy.example.com"
export TEMPMAILLOL_PROXY_SHARED_TOKEN="your-shared-token"
npm run dev
```

### Cloudflare Workers

在平台环境变量中添加：

- `TEMPMAILLOL_PROXY_BASE_URL`
- `TEMPMAILLOL_PROXY_SHARED_TOKEN`

### Docker

```bash
docker run -d -p 8787:8787 \
  -e TEMPMAILHUB_API_KEY="your-api-key" \
  -e TEMPMAILLOL_PROXY_BASE_URL="https://proxy.example.com" \
  -e TEMPMAILLOL_PROXY_SHARED_TOKEN="your-shared-token" \
  --name tempmailhub \
  ghcr.io/xiaoh2018/tempmailhub:latest
```

## 为什么仍然保留 CodeTabs 作为最后兜底

`CodeTabs` 现在不是主代理，而只是最后一层回退。

保留它的原因是：

- 自有代理临时异常时还能再尝试一次
- 某些轻量部署场景下可以作为过渡方案
- 对自有代理临时失败但不想立即中断的情况更友好

但它仍然不适合作为长期生产主链路。

## 为什么不建议继续把 CodeTabs 作为主代理

把公共代理当主代理有几个问题：

- 可用性不可控
- 容易被频率限制
- 第三方服务策略随时可能变化
- 不适合长期生产部署
- 无法做访问鉴权和日志审计

改成“自有代理优先”后，你可以自行控制：

- 代理域名
- 访问频率
- 访问日志
- 访问鉴权
- 上游 API Key

## 建议

- 如果你有 `Tempmail.lol` 官方付费 key，优先在代理服务中使用
- 如果没有官方 key，至少给代理服务加上 `X-Proxy-Token` 校验
- 不建议继续依赖公共免费代理作为生产主链路
- `CodeTabs` 更适合作为临时补位，而不是长期核心依赖
