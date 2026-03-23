/**
 * TempMailHub - 临时邮件网关服务
 * 基于 Hono 框架的多平台临时邮箱聚合服务
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { initializeProviders } from './providers/index.js';
import { mailService } from './services/mail-service.js';
import { createApiKeyAuthWithCustomError, getAuthConfig } from './middleware/api-auth.js';
import { setRuntimeBindings } from './runtime/env-store.js';

// 基础类型定义
interface AppResponse {
  success: boolean;
  data?: any;
  message?: string;
  error?: string;
  timestamp: string;
  provider?: string;
}

// 创建 Hono 应用实例
const app = new Hono();

// 全局中间件
app.use('*', cors());
app.use('*', logger());
app.use('*', async (c, next) => {
  if (c.env && typeof c.env === 'object') {
    setRuntimeBindings(c.env as Record<string, unknown>);
  }
  await next();
});
app.use('/api/*', prettyJSON());

// 创建API Key验证中间件
const apiKeyAuth = createApiKeyAuthWithCustomError();

// 应用初始化状态
// 在应用启动时初始化providers（仅包含基本配置，不进行网络调用）
console.log('🚀 Starting TempMailHub initialization...');
await initializeProviders();
console.log('✅ TempMailHub initialized successfully');

// 主页路由
app.get('/', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TempMailHub - 临时邮件网关服务</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #0f172a;
            background: #ffffff;
            min-height: 100vh;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 0 20px;
        }
        
        .hero {
            text-align: center;
            padding: 80px 0 60px;
            background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
        }
        
        .hero h1 {
            font-size: 3.5rem;
            font-weight: 800;
            color: #0f172a;
            margin-bottom: 16px;
            letter-spacing: -0.025em;
        }
        
        .hero .subtitle {
            font-size: 1.25rem;
            color: #64748b;
            margin-bottom: 0;
            max-width: 600px;
            margin-left: auto;
            margin-right: auto;
        }
        
        .hero .version {
            display: inline-flex;
            align-items: center;
            background: #e0f2fe;
            color: #0369a1;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 0.875rem;
            font-weight: 500;
            margin-bottom: 24px;
        }
        
        .github-btn {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: #0f172a;
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            text-decoration: none;
            font-weight: 500;
            transition: all 0.2s ease;
            margin-top: 32px;
        }
        
        .github-btn:hover {
            background: #1e293b;
            transform: translateY(-1px);
        }
        
        .features {
            padding: 80px 0;
            background: white;
        }
        
        .section-title {
            text-align: center;
            font-size: 2.5rem;
            font-weight: 700;
            color: #0f172a;
            margin-bottom: 16px;
        }
        
        .section-subtitle {
            text-align: center;
            font-size: 1.125rem;
            color: #64748b;
            margin-bottom: 64px;
            max-width: 600px;
            margin-left: auto;
            margin-right: auto;
        }
        
        .feature-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 32px;
            max-width: 1200px;
            margin: 0 auto;
        }
        
        .feature-card {
            text-align: left;
        }
        
        .feature-icon {
            width: 48px;
            height: 48px;
            background: #dbeafe;
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.5rem;
            margin-bottom: 24px;
        }
        
        .feature-card h3 {
            font-size: 1.5rem;
            font-weight: 600;
            color: #0f172a;
            margin-bottom: 12px;
        }
        
        .feature-list {
            list-style: none;
            color: #475569;
        }
        
        .feature-list li {
            margin-bottom: 8px;
            padding-left: 24px;
            position: relative;
        }
        
        .feature-list li:before {
            content: "✓";
            position: absolute;
            left: 0;
            color: #059669;
            font-weight: 600;
        }
        
        .providers-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 12px;
            margin-top: 16px;
        }
        
        .provider-link {
            display: block;
            padding: 12px 16px;
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            color: #0ea5e9;
            text-decoration: none;
            font-weight: 500;
            text-align: center;
            transition: all 0.2s ease;
        }
        
        .provider-link:hover {
            background: #e0f2fe;
            border-color: #0ea5e9;
            transform: translateY(-1px);
        }
        
        .serverless-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 12px;
            margin-top: 16px;
        }
        
        .platform-item {
            padding: 12px;
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            transition: all 0.2s ease;
        }
        
        .platform-item:hover {
            background: #f1f5f9;
            border-color: #cbd5e1;
        }
        
        .platform-item strong {
            display: block;
            color: #0f172a;
            font-weight: 600;
            margin-bottom: 4px;
        }
        
        .platform-item span {
            color: #64748b;
            font-size: 0.875rem;
        }
        
        .footer {
            background: #f8fafc;
            border-top: 1px solid #e2e8f0;
            padding: 48px 0;
            text-align: center;
            color: #64748b;
        }
        
        .footer-links {
            display: flex;
            justify-content: center;
            gap: 32px;
            margin-bottom: 24px;
            flex-wrap: wrap;
        }
        
        .footer-links a {
            color: #0ea5e9;
            text-decoration: none;
            font-weight: 500;
        }
        
        .footer-links a:hover {
            text-decoration: underline;
        }
        
        .footer-note {
            font-size: 0.875rem;
            opacity: 0.8;
        }
        
        @media (max-width: 1024px) {
            .feature-grid { 
                grid-template-columns: 1fr;
                gap: 24px;
            }
        }
        
        @media (max-width: 768px) {
            .hero h1 { 
                font-size: 2.5rem; 
            }
            
            .hero .subtitle { 
                font-size: 1.125rem; 
            }
            
            .feature-grid { 
                grid-template-columns: 1fr;
                gap: 32px;
            }
            
            .section-title { 
                font-size: 2rem; 
            }
            
            .footer-links {
                gap: 16px;
                flex-direction: column;
            }
            
            .providers-grid {
                grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
                gap: 8px;
            }
            
            .provider-link {
                padding: 10px 12px;
                font-size: 0.875rem;
            }
            
            .github-btn {
                padding: 10px 20px;
                font-size: 0.875rem;
            }
            
            .serverless-grid {
                gap: 8px;
            }
            
            .platform-item {
                padding: 10px;
            }
        }
    </style>
</head>
<body>
    <main>
        <section class="hero">
            <div class="container">
                <div class="version">
                    🚀 V2.0 - 全新架构
                </div>
                <h1>TempMailHub</h1>
                <p class="subtitle">
                    开源的临时邮件网关服务 - 聚合多个邮箱服务商，支持全平台 Serverless 部署
                </p>
                
                <a href="https://github.com/xiaoh2018/tempmailhub" target="_blank" class="github-btn">
                    <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                    </svg>
                    GitHub
                </a>
            </div>
        </section>

        <section class="features">
            <div class="container">
                <h2 class="section-title">为什么选择 TempMailHub？</h2>
                <p class="section-subtitle">
                    开源、简洁、易扩展 - 为开发者量身打造的临时邮箱API聚合服务
                </p>
                
                <div class="feature-grid">
                    <div class="feature-card">
                        <div class="feature-icon">🌟</div>
                        <h3>核心特性</h3>
                        <ul class="feature-list">
                            <li>聚合多个临时邮箱服务</li>
                            <li>统一的 REST API 接口</li>
                            <li>🔧 插件化架构，易扩展</li>
                            <li>🔒 双层认证架构</li>
                            <li>⚡ 智能 Provider 选择</li>
                            <li>📦 开箱即用，零配置启动</li>
                            <li>🌐 完全开源，社区驱动</li>
                        </ul>
                    </div>
                    
                    <div class="feature-card">
                        <div class="feature-icon">📧</div>
                        <h3>支持的服务商</h3>
                        <div class="providers-grid">
                            <a href="https://tempmail.lol" target="_blank" class="provider-link">
                                Tempmail.lol
                            </a>
                            <a href="https://duckmail.sbs" target="_blank" class="provider-link">
                                DuckMail
                            </a>
                            <a href="https://tempmail.ing" target="_blank" class="provider-link">
                                Tempmail.ing
                            </a>
                            <a href="https://minmail.app" target="_blank" class="provider-link">
                                MinMail
                            </a>
                            <a href="https://mail.tm" target="_blank" class="provider-link">
                                Mail.tm
                            </a>
                            <a href="https://etempmail.com" target="_blank" class="provider-link">
                                EtempMail
                            </a>
                        </div>
                        <p style="margin-top: 16px; color: #64748b; font-size: 0.875rem;">
                            🔧 <strong>架构优势</strong>：基于插件化设计，新增服务商只需实现 IMailProvider 接口
                        </p>
                    </div>

                    <div class="feature-card">
                        <div class="feature-icon">🚀</div>
                        <h3>Serverless 部署</h3>
                        <div class="serverless-grid">
                            <div class="platform-item">
                                <strong>Cloudflare Workers</strong>
                                <span>边缘计算，全球加速</span>
                            </div>
                            <div class="platform-item">
                                <strong>Deno Deploy</strong>
                                <span>现代运行时，TypeScript原生</span>
                            </div>
                            <div class="platform-item">
                                <strong>Vercel</strong>
                                <span>前端友好，自动部署</span>
                            </div>
                            <div class="platform-item">
                                <strong>Netlify</strong>
                                <span>简单配置，快速上线</span>
                            </div>
                        </div>
                        <p style="margin-top: 16px; color: #64748b; font-size: 0.875rem;">
                            🌐 <strong>部署优势</strong>：一键部署，自动扩展，按需付费
                        </p>
                    </div>
                </div>
                
                
            </div>
        </section>
    </main>

    <footer class="footer">
        <div class="container">
            <div class="footer-links">
                <a href="/api/info">API 信息</a>
                <a href="/health">服务状态</a>
                <a href="https://github.com/xiaoh2018/tempmailhub" target="_blank">GitHub</a>
            </div>
            <p class="footer-note">
                ⚠️ 仅提供 API 聚合服务，如需 UI 界面请访问各服务商官网 <br>
                TempMailHub - 让临时邮箱使用更简单 ❤️
            </p>
        </div>
    </footer>
</body>
</html>
  `);
});

// 健康检查路由
app.get('/health', (c) => {
  const response: AppResponse = {
    success: true,
    message: 'TempMailHub is running',
    data: {
      version: '1.0.0',
      status: 'healthy',
      uptime: typeof globalThis !== 'undefined' && (globalThis as any).process?.uptime ? (globalThis as any).process.uptime() : 0
    },
    timestamp: new Date().toISOString()
  };

  return c.json(response);
});

// API 信息路由
app.get('/api/info', (c) => {
  const response: AppResponse = {
    success: true,
    data: {
      name: 'TempMailHub',
      version: '1.0.0',
      description: 'Temporary email gateway service',
      features: [
        'Multiple provider aggregation',
        'Unified API interface',
        'Multi-platform deployment',
        'Dynamic channel configuration',
        'Health monitoring',
        'Error handling and retry mechanisms'
      ],
      providers: [
        { id: 'tempmaillol', name: 'Tempmail.lol', domains: ['服务端分配'], customizable: false },
        { id: 'duckmail', name: 'DuckMail', domains: ['动态域名池'], customizable: true },
        { id: 'tempmailing', name: 'Tempmail.ing', domains: ['服务端分配'], customizable: false },
        { id: 'minmail', name: 'MinMail', domains: ['atminmail.com'], customizable: false },
        { id: 'mailtm', name: 'Mail.tm', domains: ['自动选择可用公网域名'], customizable: false },
        { id: 'etempmail', name: 'EtempMail', domains: ['cross.edu.pl', 'ohm.edu.pl', 'usa.edu.pl', 'beta.edu.pl'], customizable: true }
      ],
      authentication: {
        enabled: getAuthConfig(c.env).enabled,
        method: 'Bearer Token',
        header: 'Authorization: Bearer <api-key>',
        note: getAuthConfig(c.env).enabled 
          ? 'API Key authentication is enabled. Protected endpoints require valid API key.'
          : 'API Key authentication is disabled. All endpoints are publicly accessible.'
      },
      endpoints: {
        public: [
          'GET /health - 健康检查',
          'GET /api/info - API 信息',
          'POST /api/mail/providers/test-connections - 测试所有提供者连接',
          'GET /api/mail/providers/stats - 提供者统计信息'
        ],
        protected: [
          'POST /api/mail/create - 创建临时邮箱',
          'POST /api/mail/list - 获取邮件列表',
          'POST /api/mail/content - 获取邮件详情'
        ]
      }
    },
    timestamp: new Date().toISOString()
  };

  return c.json(response);
});

// 创建邮箱路由
app.post('/api/mail/create', apiKeyAuth, async (c) => {
  try {
    let body = {};
    
    try {
      body = await c.req.json();
    } catch (error) {
      // 如果没有body或解析失败，使用默认空对象
    }

    const result = await mailService.createEmail(body);
    
    return c.json(result, result.success ? 200 : 400);
  } catch (error) {
    const response: AppResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
      timestamp: new Date().toISOString()
    };

    return c.json(response, 500);
  }
});

// 获取邮件列表路由 (POST)
app.post('/api/mail/list', apiKeyAuth, async (c) => {
  try {
    const body = await c.req.json();
    
    if (!body.address) {
      return c.json({
        success: false,
        error: 'Email address is required',
        timestamp: new Date().toISOString()
      }, 400);
    }

    // 只从请求体中获取accessToken，避免与API Key认证冲突
    const accessToken = body.accessToken;

    const query = {
      address: body.address,
      provider: body.provider,
      accessToken,
      limit: body.limit || 20,
      offset: body.offset || 0,
      unreadOnly: body.unreadOnly === true,
      since: body.since ? new Date(body.since) : undefined
    };

    const result = await mailService.getEmails(query);
    
    return c.json(result, result.success ? 200 : 400);
  } catch (error) {
    const response: AppResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Invalid request body or internal server error',
      timestamp: new Date().toISOString()
    };

    return c.json(response, 500);
  }
});

// 获取邮件详情路由 (POST)
app.post('/api/mail/content', apiKeyAuth, async (c) => {
  try {
    const body = await c.req.json();
    
    if (!body.address || !body.id) {
      return c.json({
        success: false,
        error: 'Email address and email ID are required',
        timestamp: new Date().toISOString()
      }, 400);
    }

    // 只从请求体中获取accessToken，避免与API Key认证冲突
    const accessToken = body.accessToken;

    const result = await mailService.getEmailContent(body.address, body.id, body.provider, accessToken);
    
    return c.json(result, result.success ? 200 : 404);
  } catch (error) {
    const response: AppResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Invalid request body or internal server error',
      timestamp: new Date().toISOString()
    };

    return c.json(response, 500);
  }
});




// 强制测试所有provider连接状态
app.post('/api/mail/providers/test-connections', async (c) => {
  try {
    // 强制重新测试所有provider的连接
    const result = await mailService.getProvidersHealth();
    
    return c.json({
      success: true,
      message: 'All providers tested',
      data: result.data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to test provider connections',
      timestamp: new Date().toISOString()
    }, 500);
  }
});

// 提供者统计信息路由
app.get('/api/mail/providers/stats', (c) => {
  try {
    const result = mailService.getProvidersStats();
    return c.json(result, result.success ? 200 : 500);
  } catch (error) {
    const response: AppResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
      timestamp: new Date().toISOString()
    };

    return c.json(response, 500);
  }
});



// 404 处理
app.notFound((c) => {
  return c.json({
    success: false,
    error: 'Endpoint not found',
    timestamp: new Date().toISOString()
  }, 404);
});

// 错误处理
app.onError((err, c) => {
  console.error('Application error:', err);
  return c.json({
    success: false,
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  }, 500);
});

// 导出应用实例
export default app; 
