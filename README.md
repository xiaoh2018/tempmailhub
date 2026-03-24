# TempMailHub 后端 README

## 项目定位

`_tempmailhub_src` 是本项目的后端聚合服务源码。

它基于 Hono 构建，负责统一封装多个临时邮箱渠道，对外提供统一的创建邮箱、读取收件箱、读取邮件详情、渠道健康检查与统计接口。

当前仓库地址：

- `https://github.com/xiaoh2018/tempmailhub`

## 当前状态

本次已完成的本地检查：

- `npm run build` 通过

本次已完成的在线 smoke test：

- 线上 `https://mail.3vhost.eu.org/api/mail/create` 可成功创建 MinMail 邮箱
- 线上 `https://mail.3vhost.eu.org/api/mail/list` 可使用 MinMail token 正常读取空收件箱

当前已确认：

- MinMail 已按“每个邮箱独立 accessToken”模式修复
- 当前仓库代码已推送到 GitHub 主分支

## 当前支持的渠道

后端当前接入 7 个渠道：

- `tempmaillol` / Tempmail.lol
- `duckmail` / DuckMail
- `tempmailing` / Tempmail.ing
- `minmail` / MinMail
- `mailtm` / Mail.tm
- `etempmail` / EtempMail
- `yydsmail` / YYDS Mail

## token 说明

这些渠道建议或必须显式回传 `accessToken`：

- Tempmail.lol
- DuckMail
- MinMail
- Mail.tm
- YYDS Mail

这些渠道当前不强制依赖 token：

- Tempmail.ing
- EtempMail

### MinMail 特别说明

MinMail 当前逻辑为：

- 创建邮箱时生成独立 `visitor-id`
- 将其作为 `accessToken` 返回给调用方
- 读取收件箱和邮件详情时优先使用该 token

如果客户端只保存邮箱地址、不保存 token，MinMail 收件箱行为会不稳定。

## 主要 API

### 公共接口

- `GET /health`
- `GET /api/info`
- `GET /api/mail/providers/stats`
- `POST /api/mail/providers/test-connections`

### 受保护接口

- `POST /api/mail/create`
- `POST /api/mail/list`
- `POST /api/mail/content`

## 核心接口示例

### 1. 创建邮箱

```bash
curl -X POST http://localhost:8787/api/mail/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"provider":"mailtm"}'
```

### 2. 获取收件箱

```bash
curl -X POST http://localhost:8787/api/mail/list \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "provider":"minmail",
    "address":"example@atminmail.com",
    "accessToken":"provider-specific-token",
    "limit":10
  }'
```

### 3. 获取邮件详情

```bash
curl -X POST http://localhost:8787/api/mail/content \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "provider":"minmail",
    "address":"example@atminmail.com",
    "id":"message-id",
    "accessToken":"provider-specific-token"
  }'
```

更完整的参数说明请看：

- [API_DOCUMENTATION.md](/h:/VS/聚合邮箱/_tempmailhub_src/API_DOCUMENTATION.md)

## 认证说明

后端认证变量：

- `TEMPMAILHUB_API_KEY`

行为如下：

- 如果设置了 `TEMPMAILHUB_API_KEY`，则保护接口需要 `Authorization: Bearer <api-key>`
- 如果没有设置，则接口公开可访问

## Tempmail.lol 代理相关变量

后端当前支持 Tempmail.lol 自有代理优先模式。

相关变量：

- `TEMPMAILLOL_PROXY_BASE_URL`
- `TEMPMAILLOL_PROXY_SHARED_TOKEN`

说明文档见：

- [TEMPMAILLOL_PROXY.md](/h:/VS/聚合邮箱/_tempmailhub_src/TEMPMAILLOL_PROXY.md)

## 本地开发

### 安装依赖

```bash
npm install
```

### 开发运行

```bash
npm run dev
```

或：

```bash
npm run dev:node
```

### 构建

```bash
npm run build
```

### 测试

```bash
npm test
```

## 多平台部署

当前脚本已预留多平台部署入口：

- `npm run deploy:cloudflare`
- `npm run deploy:vercel`
- `npm run deploy:deno`
- `npm run deploy:netlify`

部署细节见：

- [DEPLOYMENT.md](/h:/VS/聚合邮箱/_tempmailhub_src/DEPLOYMENT.md)

## 目录结构

当前目录重点如下：

- `src/index.ts`：主入口
- `src/providers/`：各邮箱渠道适配器
- `src/services/`：邮箱业务逻辑
- `src/middleware/`：认证等中间件
- `src/routes/`：路由封装
- `src/types/`：类型定义
- `src/utils/`：辅助工具
- `API_DOCUMENTATION.md`：完整 API 文档
- `API_SECURITY.md`：认证与安全说明
- `DEPLOYMENT.md`：部署说明
- `TEMPMAILLOL_PROXY.md`：Tempmail.lol 代理机制说明

## 当前 provider 文件

当前 provider 实现位于：

- `src/providers/tempmail-lol.ts`
- `src/providers/duckmail.ts`
- `src/providers/tempmail-ing.ts`
- `src/providers/minmail.ts`
- `src/providers/mail-tm.ts`
- `src/providers/etempmail.ts`
- `src/providers/yydsmail.ts`

## 适合继续修改的入口

后续如果继续改后端，优先看这些文件：

- [src/index.ts](/h:/VS/聚合邮箱/_tempmailhub_src/src/index.ts)
- [src/providers/index.ts](/h:/VS/聚合邮箱/_tempmailhub_src/src/providers/index.ts)
- [src/providers/minmail.ts](/h:/VS/聚合邮箱/_tempmailhub_src/src/providers/minmail.ts)
- [src/providers/tempmail-lol.ts](/h:/VS/聚合邮箱/_tempmailhub_src/src/providers/tempmail-lol.ts)
- [src/services/mail-service.ts](/h:/VS/聚合邮箱/_tempmailhub_src/src/services/mail-service.ts)
- [src/middleware/api-auth.ts](/h:/VS/聚合邮箱/_tempmailhub_src/src/middleware/api-auth.ts)

## 注意事项

- 这是聚合后端，不负责托管真实邮箱账号
- 上游渠道策略变化会直接影响成功率与返回格式
- 需要 token 的渠道，客户端应自行保存并回传 token
- 公共代理只能作为兜底，不适合作为长期主链路
- 如果用于生产，建议开启 `TEMPMAILHUB_API_KEY`

## 补充说明

如果你同时维护静态版和 EdgePages 版：

- 静态版目录：`../静态index`
- EdgePages 目录：`../edgepages版本`

建议保持三端文档、渠道列表和 token 规则同步。
