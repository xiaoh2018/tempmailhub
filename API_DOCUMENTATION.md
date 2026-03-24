# TempMailHub API 文档

## 概览

TempMailHub 是一个聚合型临时邮箱 API 网关，当前统一接入以下 7 个渠道：

- `tempmaillol` / Tempmail.lol
- `duckmail` / DuckMail
- `tempmailing` / Tempmail.ing
- `minmail` / MinMail
- `mailtm` / Mail.tm
- `etempmail` / EtempMail
- `yydsmail` / YYDS Mail

## Base URL

本地开发默认地址：

```text
http://localhost:8787
```

## 认证说明

### 第一层：TempMailHub API Key

如果服务端启用了 API Key，受保护接口需要在请求头中传入：

```http
Authorization: Bearer YOUR_API_KEY
```

### 第二层：Provider AccessToken

以下渠道在收件箱读取阶段建议显式传入 `accessToken`：

- Tempmail.lol
- DuckMail
- MinMail
- Mail.tm
- YYDS Mail

重要说明：

- `accessToken` 会在创建邮箱成功后由对应渠道返回。
- `accessToken` 应放在 JSON 请求体中，不要放进 `Authorization` 请求头。
- 对于 Serverless / 冷启动场景，不要依赖服务端内存缓存 token，客户端应自行保存并回传。
- `/api/mail/list` 同时兼容 `accessToken` 和 `token` 字段。
- `/api/mail/content` 同时兼容 `emailId` 和 `id` 字段。

示例：

```json
{
  "address": "demo@example.com",
  "provider": "mailtm",
  "accessToken": "provider_specific_token"
}
```

## 提供商能力对比

| 提供商 | 渠道 ID | 域名 | 需要 accessToken | 支持自定义域名 | 支持自定义前缀 | 说明 |
|-------|---------|------|------------------|----------------|----------------|------|
| Tempmail.lol | `tempmaillol` | 服务端分配 | ✅ | ❌ | ❌ | 优先走 `TEMPMAILLOL_PROXY_BASE_URL`，不通时再试 CodeTabs |
| DuckMail | `duckmail` | 动态域名池 | ✅ | ✅ | ✅ | 可指定域名和前缀 |
| Tempmail.ing | `tempmailing` | 服务端分配 | ❌ | ❌ | ❌ | 创建与收件流程简单 |
| MinMail | `minmail` | `atminmail.com` | ✅ | ❌ | ❌ | 创建返回 visitor-id accessToken |
| Mail.tm | `mailtm` | 动态公网域名 | ✅ | ❌ | ✅ | 创建时返回 accessToken |
| EtempMail | `etempmail` | `cross.edu.pl` `ohm.edu.pl` `usa.edu.pl` `beta.edu.pl` | ❌ | ✅ | ✅ | 支持教育域名 |
| YYDS Mail | `yydsmail` | 动态公网域名池 | ✅ | ❌ | ❌ | 创建返回 accessToken，支持消息详情接口 |

## 公共接口

### `GET /health`

服务健康检查。

### `GET /api/info`

返回服务名称、版本、已启用渠道、认证状态和接口说明。

### `POST /api/mail/providers/test-connections`

测试所有 provider 的连通性。

### `GET /api/mail/providers/stats`

查看 provider 统计信息。

## 受保护接口

### `POST /api/mail/create`

创建一个临时邮箱。

请求体：

```json
{
  "provider": "duckmail",
  "prefix": "demo123",
  "domain": "example-domain.tld",
  "expirationMinutes": 1440
}
```

字段说明：

- `provider`：可选，指定渠道 ID；不传时由服务端按能力和优先级自动选择。
- `prefix`：可选，自定义前缀。仅支持前缀的渠道会生效。
- `domain`：可选，自定义域名。仅支持自定义域名的渠道会生效。
- `expirationMinutes`：可选，部分 provider 可能忽略。

常见创建示例：

```bash
# Tempmail.lol
curl -X POST http://localhost:8787/api/mail/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"provider": "tempmaillol"}'

# DuckMail（指定前缀，域名可省略）
curl -X POST http://localhost:8787/api/mail/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"provider": "duckmail", "prefix": "demo123"}'

# Tempmail.ing
curl -X POST http://localhost:8787/api/mail/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"provider": "tempmailing"}'

# MinMail
curl -X POST http://localhost:8787/api/mail/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"provider": "minmail"}'

# Mail.tm
curl -X POST http://localhost:8787/api/mail/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"provider": "mailtm"}'

# EtempMail（指定域名）
curl -X POST http://localhost:8787/api/mail/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"provider": "etempmail", "domain": "ohm.edu.pl"}'

# YYDS Mail
curl -X POST http://localhost:8787/api/mail/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"provider": "yydsmail"}'
```

成功响应示例：

```json
{
  "success": true,
  "data": {
    "address": "demo123@sharebot.net",
    "domain": "sharebot.net",
    "username": "demo123",
    "provider": "mailtm",
    "accessToken": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9..."
  },
  "timestamp": "2026-03-23T08:00:00.000Z",
  "provider": "mailtm"
}
```

说明：

- `accessToken` 仅在需要 token 的渠道中返回。
- 客户端应优先保存 `address`、`provider`、`accessToken` 三个字段。

### `POST /api/mail/list`

获取指定邮箱的邮件列表。

请求体：

```json
{
  "address": "demo123@sharebot.net",
  "provider": "mailtm",
  "accessToken": "provider_specific_token",
  "limit": 20,
  "offset": 0,
  "unreadOnly": false,
  "since": "2026-03-23T00:00:00.000Z"
}
```

字段说明：

- `address`：必填，邮箱地址。
- `provider`：可选，不传时会根据邮箱域名推断；建议在多渠道环境中显式传入。`yydsmail` 由于域名池动态变化，更推荐显式传值。
- `accessToken` / `token`：可选但推荐；Tempmail.lol、DuckMail、MinMail、Mail.tm、YYDS Mail 使用时应传入。
- `limit`：可选，默认 `20`。
- `offset`：可选，默认 `0`。
- `unreadOnly`：可选，默认 `false`。
- `since`：可选，ISO 时间字符串。

响应示例：

```json
{
  "success": true,
  "data": [
    {
      "id": "msg_123",
      "from": {
        "email": "sender@example.com",
        "name": "Sender Name"
      },
      "to": [
        {
          "email": "demo123@sharebot.net"
        }
      ],
      "subject": "Your verification code",
      "textContent": "Your verification code is 123456",
      "receivedAt": "2026-03-23T08:05:00.000Z",
      "isRead": false,
      "provider": "mailtm"
    }
  ],
  "timestamp": "2026-03-23T08:06:00.000Z",
  "provider": "mailtm"
}
```

说明：

- `textContent` 是标准化后的文本内容或摘要。
- 如果渠道支持详情接口，建议再调用 `/api/mail/content` 获取完整正文。

### `POST /api/mail/content`

获取单封邮件详情。

请求体：

```json
{
  "address": "demo123@sharebot.net",
  "id": "msg_123",
  "provider": "mailtm",
  "accessToken": "provider_specific_token"
}
```

字段说明：

- `address`：必填，邮箱地址。
- `id` 或 `emailId`：必填，邮件 ID。
- `provider`：可选，建议显式传入。
- `accessToken` / `token`：对需要 token 的渠道建议传入。

响应示例：

```json
{
  "success": true,
  "data": {
    "id": "msg_123",
    "from": {
      "email": "sender@example.com",
      "name": "Sender Name"
    },
    "to": [
      {
        "email": "demo123@sharebot.net"
      }
    ],
    "subject": "Your verification code",
    "textContent": "Your verification code is 123456",
    "htmlContent": "<html><body><p>Your verification code is <strong>123456</strong></p></body></html>",
    "receivedAt": "2026-03-23T08:05:00.000Z",
    "isRead": false,
    "provider": "mailtm"
  },
  "timestamp": "2026-03-23T08:06:00.000Z",
  "provider": "mailtm"
}
```

## 典型接入流程

### 流程 A：需要 accessToken 的渠道

适用渠道：

- Tempmail.lol
- DuckMail
- MinMail
- Mail.tm
- YYDS Mail

步骤：

1. 调用 `/api/mail/create`
2. 保存 `address`、`provider`、`accessToken`
3. 调用 `/api/mail/list` 时把 `accessToken` 带回去
4. 调用 `/api/mail/content` 时同样带回 `accessToken`

### 流程 B：无需 accessToken 的渠道

适用渠道：

- Tempmail.ing
- EtempMail

步骤：

1. 调用 `/api/mail/create`
2. 保存 `address`、`provider`
3. 调用 `/api/mail/list`
4. 如需详情再调用 `/api/mail/content`

## JavaScript 示例

```js
const API_BASE = "http://localhost:8787";
const API_KEY = "YOUR_API_KEY";

async function callApi(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error?.message || data.message || "Request failed");
  }

  return data.data;
}

async function demo() {
  const mailbox = await callApi("/api/mail/create", { provider: "mailtm" });

  const emails = await callApi("/api/mail/list", {
    address: mailbox.address,
    provider: mailbox.provider,
    accessToken: mailbox.accessToken
  });

  if (emails.length > 0) {
    const detail = await callApi("/api/mail/content", {
      address: mailbox.address,
      provider: mailbox.provider,
      id: emails[0].id,
      accessToken: mailbox.accessToken
    });
    console.log(detail.subject);
  }
}
```

## Python 示例

```python
import requests

API_BASE = "http://localhost:8787"
API_KEY = "YOUR_API_KEY"

def call_api(path, payload):
    response = requests.post(
        f"{API_BASE}{path}",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
        },
        json=payload,
        timeout=30,
    )
    data = response.json()
    if not response.ok or not data.get("success"):
        raise RuntimeError(data.get("error", {}).get("message") or data.get("message") or "Request failed")
    return data["data"]

mailbox = call_api("/api/mail/create", {"provider": "duckmail", "prefix": "demo123"})
emails = call_api("/api/mail/list", {
    "address": mailbox["address"],
    "provider": mailbox["provider"],
    "accessToken": mailbox.get("accessToken"),
})

if emails:
    detail = call_api("/api/mail/content", {
        "address": mailbox["address"],
        "provider": mailbox["provider"],
        "id": emails[0]["id"],
        "accessToken": mailbox.get("accessToken"),
    })
    print(detail["subject"])
```

## 常见问题

### 1. 为什么创建成功后查不到收件箱？

优先检查是否把 `accessToken` 一起传回来了。对 Tempmail.lol、DuckMail、MinMail、Mail.tm、YYDS Mail，建议总是显式传递。

### 2. `accessToken` 可以放在请求头里吗？

不可以。`Authorization` 头只用于 TempMailHub 的 API Key。provider token 必须放在 JSON 请求体中。

### 3. 为什么不传 `provider` 也能查邮件？

服务端会尝试按邮箱域名推断 provider，但为了减少歧义，生产环境建议始终显式传入 `provider`。

### 4. Tempmail.lol 为什么偶尔失败？

Tempmail.lol 免费层可能触发风控或频率限制。当前服务端已加入代理兜底，但上游状态仍可能影响成功率。

## 错误排查

- `401 Unauthorized`
  - 检查 TempMailHub API Key 是否正确。
- `No authentication token provided`
  - 说明当前渠道需要 `accessToken`，请把创建邮箱返回的 token 带回 `/api/mail/list` 或 `/api/mail/content`。
- `No available email provider found`
  - 说明指定的 provider 未启用，或请求中的 provider 名称不存在。
- `Email with ID ... not found`
  - 说明邮件列表已变化，建议先重新调用 `/api/mail/list` 再取详情。

## 仓库地址

- GitHub: `https://github.com/xiaoh2018/tempmailhub`
