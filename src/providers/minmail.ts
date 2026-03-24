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
import { generateId, generateRandomString, parseDate, stripHtml } from '../utils/helpers.js';

/**
 * MinMail API 响应类型
 */
interface MinMailAddressResponse {
  address: string;
  expire: number;
  remainingTime: number;
}

interface MinMailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  preview: string;
  content: string;
  date: string;
  isRead: boolean;
}

interface MinMailListResponse {
  message: MinMailMessage[];
}

/**
 * MinMail 提供者实现
 */
export class MinMailProvider implements IMailProvider {
  readonly name = 'minmail';
  
  readonly capabilities: ChannelCapabilities = {
    createEmail: true,
    listEmails: true,
    getEmailContent: true,
    customDomains: false,
    customPrefix: false,
    emailExpiration: true,
    realTimeUpdates: false,
    attachmentSupport: false
  };

  private stats: ChannelStats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    averageResponseTime: 0,
    errorsToday: 0,
    requestsToday: 0
  };

  private readonly tokenStore = new Map<string, string>();
  private connectionTested = false;
  private connectionTestResult: { success: boolean; error?: string; testedAt: Date } | null = null;

  constructor(public readonly config: ChannelConfiguration) {}

  async initialize(config: ChannelConfiguration): Promise<void> {
    // 生成或获取 visitor-id
    console.log('MinMail provider initialized (connection will be tested on first use)');
  }

  /**
   * 懒加载连接测试 - 只在第一次使用时测试，结果会被缓存
   */
  private async ensureConnectionTested(): Promise<void> {
    if (this.connectionTested) {
      return;
    }

    try {
      console.log('Testing MinMail connection...');
      const healthCheck = await this.testConnection();
      this.connectionTestResult = {
        success: healthCheck.success,
        error: healthCheck.error?.message,
        testedAt: new Date()
      };
      
      if (!healthCheck.success) {
        console.warn(`MinMail connection test failed: ${healthCheck.error?.message}`);
      } else {
        console.log('MinMail connection test passed');
      }
    } catch (error) {
      this.connectionTestResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        testedAt: new Date()
      };
      console.warn(`MinMail connection test error: ${this.connectionTestResult.error}`);
    } finally {
      this.connectionTested = true;
    }
  }

  async createEmail(request: CreateEmailRequest): Promise<ChannelResponse<CreateEmailResponse>> {
    const startTime = Date.now();
    
    try {
      this.updateStats('request');

      const url = 'https://minmail.app/api/mail/address';
      const params = new URLSearchParams({
        refresh: 'true',
        expire: String(request.expirationMinutes || 1440), // 默认24小时
        part: 'main'
      });

      const visitorId = this.createVisitorId();

      const response = await httpClient.get<MinMailAddressResponse>(
        `${url}?${params}`,
        {
          headers: {
            'accept': '*/*',
            'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'referer': 'https://minmail.app/cn',
            'visitor-id': visitorId,
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
          },
          timeout: this.config.timeout,
          retries: this.config.retries
        }
      );

      if (!response.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          `MinMail API returned ${response.status}: ${response.statusText}`,
          response.status
        );
      }

      const data = response.data;
      if (!data.address) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          'Invalid response from MinMail API: missing address'
        );
      }

      const [username, domain] = data.address.split('@');
      const expiresAt = new Date(Date.now() + data.remainingTime * 1000);
      this.tokenStore.set(data.address, visitorId);

      const result: CreateEmailResponse = {
        address: data.address,
        domain,
        username,
        expiresAt,
        provider: this.name,
        accessToken: visitorId
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
      const visitorId = query.accessToken || this.tokenStore.get(query.address);
      if (!visitorId) {
        throw this.createError(
          ChannelErrorType.AUTHENTICATION_ERROR,
          'MinMail requires a visitor-id token for inbox access'
        );
      }
      this.tokenStore.set(query.address, visitorId);

      const url = 'https://minmail.app/api/mail/list';
      const params = new URLSearchParams({
        part: 'main'
      });

      const response = await httpClient.get<MinMailListResponse>(
        `${url}?${params}`,
        {
          headers: {
            'accept': '*/*',
            'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'referer': 'https://minmail.app/cn',
            'visitor-id': visitorId,
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
          },
          timeout: this.config.timeout,
          retries: this.config.retries
        }
      );

      if (!response.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          `MinMail API returned ${response.status}: ${response.statusText}`,
          response.status
        );
      }

      const messages = response.data.message || [];
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
    // MinMail 的列表接口已经包含完整内容，所以直接从列表中查找
    const emailsResponse = await this.getEmails({ address: emailAddress, accessToken });
    
    if (!emailsResponse.success) {
      return {
        success: false,
        error: emailsResponse.error,
        metadata: emailsResponse.metadata
      };
    }

    const email = emailsResponse.data?.find(msg => msg.id === emailId);
    if (!email) {
      return {
        success: false,
        error: this.createError(ChannelErrorType.API_ERROR, `Email with ID ${emailId} not found`),
        metadata: {
          provider: this.name,
          responseTime: 0,
          requestId: generateId()
        }
      };
    }

    return {
      success: true,
      data: email,
      metadata: {
        provider: this.name,
        responseTime: 0,
        requestId: generateId()
      }
    };
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
      const visitorId = this.createVisitorId();
      const response = await httpClient.get<MinMailAddressResponse>('https://minmail.app/api/mail/address?refresh=true&expire=1&part=main', {
        headers: {
          'accept': '*/*',
          'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
          'referer': 'https://minmail.app/cn',
          'visitor-id': visitorId,
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
        },
        timeout: this.config.timeout
      });

      const success = Boolean(response.ok && response.data?.address);

      return {
        success,
        data: success,
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

  private createVisitorId(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }

    return [
      generateRandomString(8),
      generateRandomString(4),
      generateRandomString(4),
      generateRandomString(4),
      generateRandomString(12)
    ].join('-');
  }

  private mapToEmailMessage(msg: MinMailMessage, emailAddress: string): EmailMessage {
    const fromMatch = msg.from.match(/^"?([^"]*)"?\s*<(.+)>$/) || msg.from.match(/^(.+)$/);
    const fromEmail = fromMatch?.[2] || fromMatch?.[1] || msg.from;
    const fromName = fromMatch?.[2] ? fromMatch[1] : undefined;

    return {
      id: msg.id,
      from: {
        email: fromEmail,
        name: fromName
      },
      to: [{
        email: emailAddress
      }],
      subject: msg.subject,
      textContent: stripHtml(msg.content),
      htmlContent: msg.content,
      receivedAt: parseDate(msg.date),
      isRead: msg.isRead,
      provider: this.name,
      size: msg.content.length
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
