import type { IMailProvider } from '../interfaces/mail-provider.js';
import type {
  EmailAddress,
  EmailMessage,
  CreateEmailRequest,
  CreateEmailResponse,
  EmailListQuery,
  EmailContact
} from '../types/email.js';
import type {
  ChannelConfiguration,
  ChannelHealth,
  ChannelStats,
  ChannelResponse,
  ChannelCapabilities,
  ChannelError
} from '../types/channel.js';
import { ChannelStatus, ChannelErrorType } from '../types/channel.js';
import { httpClient } from '../utils/http-client.js';
import { generateId, generateEmailPrefix, parseDate } from '../utils/helpers.js';

/**
 * Mail.tm API 响应类型
 */
interface MailTmDomain {
  '@id': string;
  '@type': string;
  id: string;
  domain: string;
  isActive: boolean;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MailTmDomainsResponse {
  '@context': string;
  '@id': string;
  '@type': string;
  'hydra:totalItems': number;
  'hydra:member': MailTmDomain[];
}

interface MailTmAccount {
  '@context': string;
  '@id': string;
  '@type': string;
  id: string;
  address: string;
  quota: number;
  used: number;
  isDisabled: boolean;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MailTmTokenResponse {
  token: string;
  '@id': string;
  id: string;
}

interface MailTmMessage {
  '@id': string;
  '@type': string;
  id: string;
  msgid: string;
  from: {
    address: string;
    name: string;
  };
  to: Array<{
    address: string;
    name: string;
  }>;
  subject: string;
  intro: string;
  seen: boolean;
  isDeleted: boolean;
  hasAttachments: boolean;
  size: number;
  downloadUrl: string;
  sourceUrl: string;
  createdAt: string;
  updatedAt: string;
  accountId: string;
}

interface MailTmMessagesResponse {
  '@context': string;
  '@id': string;
  '@type': string;
  'hydra:totalItems': number;
  'hydra:member': MailTmMessage[];
}

interface MailTmMessageDetail extends MailTmMessage {
  cc: Array<{
    address: string;
    name: string;
  }>;
  bcc: Array<{
    address: string;
    name: string;
  }>;
  flagged: boolean;
  verifications: any;
  retention: boolean;
  retentionDate: string;
  text: string;
  html: string[];
}

/**
 * Mail.tm 提供者实现
 */
export class MailTmProvider implements IMailProvider {
  readonly name = 'mailtm';
  
  readonly capabilities: ChannelCapabilities = {
    createEmail: true,
    listEmails: true,
    getEmailContent: true,
    customDomains: false, // 实际只有一个域名 somoj.com
    customPrefix: true,
    emailExpiration: true,
    realTimeUpdates: false,
    attachmentSupport: true
  };

  private stats: ChannelStats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    averageResponseTime: 0,
    errorsToday: 0,
    requestsToday: 0
  };

  private baseUrl = 'https://api.mail.tm';
  private availableDomains: string[] = [];
  private sessionTokens = new Map<string, string>(); // email -> token
  private connectionTested = false;
  private connectionTestResult: { success: boolean; error?: string; testedAt: Date } | null = null;

  constructor(public readonly config: ChannelConfiguration) {}

  async initialize(config: ChannelConfiguration): Promise<void> {
    console.log('Mail.tm provider initialized (domains and connection will be loaded on first use)');
  }

  /**
   * 懒加载连接测试和域名获取 - 只在第一次使用时执行，结果会被缓存
   */
  private async ensureConnectionTested(): Promise<void> {
    if (this.connectionTested) {
      return;
    }

    try {
      console.log('Testing Mail.tm connection and loading domains...');
      
      // 获取可用域名
      await this.fetchAvailableDomains();
      
      // 测试连接
      const healthCheck = await this.testConnection();
      this.connectionTestResult = {
        success: healthCheck.success,
        error: healthCheck.error?.message,
        testedAt: new Date()
      };
      
      if (!healthCheck.success) {
        console.warn(`Mail.tm connection test failed: ${healthCheck.error?.message}`);
      } else {
        console.log(`Mail.tm connection test passed, loaded ${this.availableDomains.length} domains`);
      }
    } catch (error) {
      this.connectionTestResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        testedAt: new Date()
      };
      console.warn(`Mail.tm connection test error: ${this.connectionTestResult.error}`);
    } finally {
      this.connectionTested = true;
    }
  }

  async createEmail(request: CreateEmailRequest): Promise<ChannelResponse<CreateEmailResponse>> {
    const startTime = Date.now();
    
    try {
      this.updateStats('request');

      await this.ensureConnectionTested();

      const prefix = request.prefix || generateEmailPrefix(10);
      // Mail.tm 实际只有一个域名，不需要随机选择
      const domain = request.domain && this.availableDomains.includes(request.domain)
        ? request.domain
        : this.availableDomains[0];
      
      if (!domain) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          'No available domains found'
        );
      }

      const address = `${prefix}@${domain}`;
      const password = this.generatePassword();

      // 创建账户
      const createResponse = await httpClient.post<MailTmAccount>(
        `${this.baseUrl}/accounts`,
        {
          address,
          password
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'accept': 'application/json'
          },
          timeout: this.config.timeout,
          retries: this.config.retries
        }
      );

      if (!createResponse.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          `Failed to create account: ${createResponse.status}`,
          createResponse.status
        );
      }

      // 获取访问令牌
      const tokenResponse = await httpClient.post<MailTmTokenResponse>(
        `${this.baseUrl}/token`,
        {
          address,
          password
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'accept': 'application/json'
          },
          timeout: this.config.timeout,
          retries: this.config.retries
        }
      );

      if (!tokenResponse.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          `Failed to get token: ${tokenResponse.status}`,
          tokenResponse.status
        );
      }

      // 保存令牌
      this.sessionTokens.set(address, tokenResponse.data.token);

      const result: CreateEmailResponse = {
        address,
        domain,
        username: prefix,
        provider: this.name,
        accessToken: tokenResponse.data.token,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7天后过期
      };

      this.updateStats('success', Date.now() - startTime);

      return {
        success: true,
        data: result,
        metadata: {
          provider: this.name,
          responseTime: Date.now() - startTime,
          requestId: generateId()
        }
      };

    } catch (error) {
      this.updateStats('error', Date.now() - startTime);
      
      return {
        success: false,
        error: error instanceof Error ? error as ChannelError : this.createError(
          ChannelErrorType.UNKNOWN_ERROR,
          error instanceof Error ? error.message : String(error)
        ),
        metadata: {
          provider: this.name,
          responseTime: Date.now() - startTime,
          requestId: generateId()
        }
      };
    }
  }

  async getEmails(query: EmailListQuery): Promise<ChannelResponse<EmailMessage[]>> {
    const startTime = Date.now();
    
    try {
      this.updateStats('request');

      // 优先使用传入的accessToken，其次使用内部存储的token
      const token = query.accessToken || this.sessionTokens.get(query.address);
      if (!token) {
        throw this.createError(
          ChannelErrorType.AUTHENTICATION_ERROR,
          'No authentication token provided. Please provide accessToken parameter or ensure email was created through this service.'
        );
      }

      const response = await httpClient.get<MailTmMessagesResponse>(
        `${this.baseUrl}/messages`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'accept': 'application/json'
          },
          timeout: this.config.timeout,
          retries: this.config.retries
        }
      );

      if (!response.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          `Mail.tm API returned ${response.status}: ${response.statusText}`,
          response.status
        );
      }

      // Mail.tm API 可能返回直接数组或者 hydra:member 格式
      const messages = Array.isArray(response.data) ? response.data : (response.data['hydra:member'] || []);
      const emails: EmailMessage[] = messages.map(msg => this.mapToEmailMessage(msg, query.address));

      // 应用过滤器
      let filteredEmails = emails;
      if (query.unreadOnly) {
        filteredEmails = filteredEmails.filter(email => !email.isRead);
      }
      if (query.since) {
        filteredEmails = filteredEmails.filter(email => email.receivedAt >= query.since!);
      }

      // 应用分页
      const limit = query.limit || 20;
      const offset = query.offset || 0;
      const paginatedEmails = filteredEmails.slice(offset, offset + limit);

      this.updateStats('success', Date.now() - startTime);

      return {
        success: true,
        data: paginatedEmails,
        metadata: {
          provider: this.name,
          responseTime: Date.now() - startTime,
          requestId: generateId()
        }
      };

    } catch (error) {
      this.updateStats('error', Date.now() - startTime);
      
      return {
        success: false,
        error: error instanceof Error ? error as ChannelError : this.createError(
          ChannelErrorType.UNKNOWN_ERROR,
          error instanceof Error ? error.message : String(error)
        ),
        metadata: {
          provider: this.name,
          responseTime: Date.now() - startTime,
          requestId: generateId()
        }
      };
    }
  }

  async getEmailContent(emailAddress: string, emailId: string, accessToken?: string): Promise<ChannelResponse<EmailMessage>> {
    const startTime = Date.now();
    
    try {
      this.updateStats('request');

      // 优先使用传入的accessToken，其次使用内部存储的token
      const token = accessToken || this.sessionTokens.get(emailAddress);
      if (!token) {
        throw this.createError(
          ChannelErrorType.AUTHENTICATION_ERROR,
          'No authentication token provided. Please provide accessToken parameter or ensure email was created through this service.'
        );
      }

      const response = await httpClient.get<MailTmMessageDetail>(
        `${this.baseUrl}/messages/${emailId}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'accept': 'application/json'
          },
          timeout: this.config.timeout,
          retries: this.config.retries
        }
      );

      if (!response.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          `Mail.tm API returned ${response.status}: ${response.statusText}`,
          response.status
        );
      }

      const email = this.mapDetailToEmailMessage(response.data, emailAddress);

      this.updateStats('success', Date.now() - startTime);

      return {
        success: true,
        data: email,
        metadata: {
          provider: this.name,
          responseTime: Date.now() - startTime,
          requestId: generateId()
        }
      };

    } catch (error) {
      this.updateStats('error', Date.now() - startTime);
      
      return {
        success: false,
        error: error instanceof Error ? error as ChannelError : this.createError(
          ChannelErrorType.UNKNOWN_ERROR,
          error instanceof Error ? error.message : String(error)
        ),
        metadata: {
          provider: this.name,
          responseTime: Date.now() - startTime,
          requestId: generateId()
        }
      };
    }
  }



  async deleteEmail(emailAddress: string): Promise<ChannelResponse<boolean>> {
    const token = this.sessionTokens.get(emailAddress);
    
    if (!token) {
      return {
        success: false,
        error: this.createError(
          ChannelErrorType.AUTHENTICATION_ERROR,
          'Email address not found'
        ),
        metadata: {
          provider: this.name,
          responseTime: 0,
          requestId: generateId()
        }
      };
    }

    try {
      // Mail.tm 支持删除账户，但这里我们只清理本地令牌
      this.sessionTokens.delete(emailAddress);
      
      return {
        success: true,
        data: true,
        metadata: {
          provider: this.name,
          responseTime: 0,
          requestId: generateId()
        }
      };
    } catch (error) {
      return {
        success: false,
        error: this.createError(
          ChannelErrorType.UNKNOWN_ERROR,
          error instanceof Error ? error.message : String(error)
        ),
        metadata: {
          provider: this.name,
          responseTime: 0,
          requestId: generateId()
        }
      };
    }
  }

  async getHealth(): Promise<ChannelHealth> {
    // 如果还没有测试过连接，现在测试一次
    if (!this.connectionTested) {
      await this.ensureConnectionTested();
    }
    
    const testResult = this.connectionTestResult || { success: false, error: 'Not tested yet', testedAt: new Date() };
    
    return {
      status: testResult.success ? ChannelStatus.ACTIVE : ChannelStatus.ERROR,
      lastChecked: testResult.testedAt,
      responseTime: 0, // 使用缓存结果，没有实时响应时间
      errorCount: this.stats.failedRequests,
      successRate: this.stats.totalRequests > 0 ? 
        (this.stats.successfulRequests / this.stats.totalRequests) * 100 : 0,
      lastError: testResult.error,
      uptime: this.stats.totalRequests > 0 ? 
        (this.stats.successfulRequests / this.stats.totalRequests) * 100 : 100
    };
  }

  getStats(): ChannelStats {
    return { ...this.stats };
  }

  async testConnection(): Promise<ChannelResponse<boolean>> {
    const startTime = Date.now();
    
    try {
      const response = await httpClient.get(`${this.baseUrl}/domains`, {
        timeout: this.config.timeout
      });

      return {
        success: response.ok,
        data: response.ok,
        metadata: {
          provider: this.name,
          responseTime: Date.now() - startTime,
          requestId: generateId()
        }
      };
    } catch (error) {
      return {
        success: false,
        error: this.createError(
          ChannelErrorType.NETWORK_ERROR,
          error instanceof Error ? error.message : String(error)
        ),
        metadata: {
          provider: this.name,
          responseTime: Date.now() - startTime,
          requestId: generateId()
        }
      };
    }
  }

/*
  private async fetchAvailableDomains(): Promise<void> {
    try {
      const response = await httpClient.get<MailTmDomainsResponse>(`${this.baseUrl}/domains`);
      
      if (response.ok) {
        this.availableDomains = response.data['hydra:member']
          .filter(domain => domain.isActive && !domain.isPrivate)
          .map(domain => domain.domain);
      }
    } catch (error) {
      // 使用默认域名
      this.availableDomains = ['somoj.com'];
    }
  }

  }
*/

  private async fetchAvailableDomains(): Promise<void> {
    const response = await httpClient.get<MailTmDomainsResponse>(`${this.baseUrl}/domains?page=1`, {
      headers: {
        accept: 'application/json'
      },
      timeout: this.config.timeout,
      retries: this.config.retries
    });

    if (!response.ok) {
      throw this.createError(
        ChannelErrorType.API_ERROR,
        `Mail.tm domains request failed: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    const domainItems = Array.isArray(response.data)
      ? response.data
      : (response.data['hydra:member'] || []);

    this.availableDomains = domainItems
      .filter(domain => domain.isActive && !domain.isPrivate)
      .map(domain => domain.domain);

    if (!this.availableDomains.length) {
      throw this.createError(
        ChannelErrorType.API_ERROR,
        'Mail.tm returned no active public domains'
      );
    }
  }

  private generatePassword(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let password = '';
    for (let i = 0; i < 12; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  private mapToEmailMessage(msg: MailTmMessage, emailAddress: string): EmailMessage {
    return {
      id: msg.id,
      from: {
        email: msg.from.address,
        name: msg.from.name || undefined
      },
      to: msg.to.map(to => ({
        email: to.address,
        name: to.name || undefined
      })),
      subject: msg.subject,
      textContent: msg.intro, // 注意：这是邮件摘要，完整内容需调用详情接口
      receivedAt: parseDate(msg.createdAt),
      isRead: msg.seen,
      provider: this.name,
      messageId: msg.msgid,
      size: msg.size,
      attachments: msg.hasAttachments ? [] : undefined,
      // 添加元数据标识
      headers: {
        'X-Content-Type': 'preview', // 标识这是预览内容
        'X-Has-Full-Content': 'true' // 标识可以获取完整内容
      }
    };
  }

  private mapDetailToEmailMessage(detail: MailTmMessageDetail, emailAddress: string): EmailMessage {
    return {
      id: detail.id,
      from: {
        email: detail.from.address,
        name: detail.from.name || undefined
      },
      to: detail.to.map(to => ({
        email: to.address,
        name: to.name || undefined
      })),
      cc: detail.cc?.map(cc => ({
        email: cc.address,
        name: cc.name || undefined
      })),
      bcc: detail.bcc?.map(bcc => ({
        email: bcc.address,
        name: bcc.name || undefined
      })),
      subject: detail.subject,
      textContent: detail.text,
      htmlContent: Array.isArray(detail.html) ? detail.html.join('') : detail.html,
      receivedAt: parseDate(detail.createdAt),
      isRead: detail.seen,
      provider: this.name,
      messageId: detail.msgid,
      size: detail.size,
      attachments: detail.hasAttachments ? [] : undefined,
      // 添加元数据标识
      headers: {
        'X-Content-Type': 'full', // 标识这是完整内容
        'X-Has-Full-Content': 'true'
      }
    };
  }

  private createError(type: ChannelErrorType, message: string, statusCode?: number): ChannelError {
    const error = new Error(message) as ChannelError;
    error.type = type;
    error.channelName = this.name;
    error.statusCode = statusCode;
    error.retryable = type !== ChannelErrorType.AUTHENTICATION_ERROR && type !== ChannelErrorType.CONFIGURATION_ERROR;
    error.timestamp = new Date();
    return error;
  }

  private updateStats(type: 'request' | 'success' | 'error', responseTime?: number): void {
    this.stats.totalRequests++;
    this.stats.requestsToday++;
    this.stats.lastRequestTime = new Date();

    if (type === 'success') {
      this.stats.successfulRequests++;
      if (responseTime) {
        this.stats.averageResponseTime = 
          (this.stats.averageResponseTime + responseTime) / 2;
      }
    } else if (type === 'error') {
      this.stats.failedRequests++;
      this.stats.errorsToday++;
    }
  }
} 
