import { Hono, Context } from 'hono';
import { mailService } from '../services/mail-service.js';
import type { CreateEmailRequest, EmailListQuery } from '../types/email.js';

const mail = new Hono();

/**
 * 创建临时邮箱
 * POST /mail/create
 */
mail.post('/create', async (c) => {
  try {
    const body = await c.req.json() as CreateEmailRequest;
    const result = await mailService.createEmail(body);
    
    return c.json(result, result.success ? 200 : 400);
  } catch (error) {
    return c.json({
      success: false,
      error: 'Invalid request body',
      timestamp: new Date().toISOString()
    }, 400);
  }
});

/**
 * 获取邮件列表
 * POST /mail/list
 */
mail.post('/list', async (c) => {
  try {
    const body = await c.req.json() as {
      address: string;
      provider?: string;
      accessToken?: string;
      token?: string;
      limit?: number;
      offset?: number;
      unreadOnly?: boolean;
      since?: string;
    };
    
    if (!body.address) {
      return c.json({
        success: false,
        error: 'Email address is required',
        timestamp: new Date().toISOString()
      }, 400);
    }

    const query: EmailListQuery = {
      address: body.address,
      provider: body.provider,
      accessToken: body.accessToken || body.token || c.req.header('Authorization')?.replace('Bearer ', ''),
      limit: body.limit || 20,
      offset: body.offset || 0,
      unreadOnly: body.unreadOnly === true
    };

    // 处理 since 参数
    if (body.since) {
      query.since = new Date(body.since);
    }

    const result = await mailService.getEmails(query);
    
    return c.json(result, result.success ? 200 : 400);
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Invalid request body or internal server error',
      timestamp: new Date().toISOString()
    }, 500);
  }
});

/**
 * 获取单个邮件详情
 * POST /mail/content
 */
mail.post('/content', async (c) => {
  try {
    const body = await c.req.json() as {
      address: string;
      emailId: string;
      id?: string;
      provider?: string;
      accessToken?: string;
      token?: string;
    };
    
    const emailId = body.emailId || body.id || '';

    if (!body.address || !emailId) {
      return c.json({
        success: false,
        error: 'Email address and email ID are required',
        timestamp: new Date().toISOString()
      }, 400);
    }

    const accessToken = body.accessToken || body.token || c.req.header('Authorization')?.replace('Bearer ', '');
    const result = await mailService.getEmailContent(body.address, emailId, body.provider, accessToken);
    
    return c.json(result, result.success ? 200 : 404);
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Invalid request body or internal server error',
      timestamp: new Date().toISOString()
    }, 500);
  }
});



/**
 * 获取提供者健康状态
 * GET /mail/providers/health
 */
mail.get('/providers/health', async (c) => {
  try {
    const result = await mailService.getProvidersHealth();
    return c.json(result, result.success ? 200 : 500);
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
      timestamp: new Date().toISOString()
    }, 500);
  }
});

/**
 * 获取提供者统计信息
 * GET /mail/providers/stats
 */
mail.get('/providers/stats', async (c) => {
  try {
    const result = mailService.getProvidersStats();
    return c.json(result, result.success ? 200 : 500);
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
      timestamp: new Date().toISOString()
    }, 500);
  }
});

export { mail }; 
