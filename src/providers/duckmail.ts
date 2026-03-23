import type { IMailProvider } from '../interfaces/mail-provider.js';
import type {
  CreateEmailRequest,
  CreateEmailResponse,
  EmailListQuery,
  EmailMessage
} from '../types/email.js';
import type {
  ChannelCapabilities,
  ChannelConfiguration,
  ChannelError,
  ChannelHealth,
  ChannelResponse,
  ChannelStats
} from '../types/channel.js';
import { ChannelErrorType, ChannelStatus } from '../types/channel.js';
import { httpClient } from '../utils/http-client.js';
import { generateEmailPrefix, generateId, parseDate } from '../utils/helpers.js';

interface DuckMailDomain {
  domain: string;
  isVerified?: boolean;
  isActive?: boolean;
}

interface DuckMailDomainsResponse {
  'hydra:member'?: DuckMailDomain[];
}

interface DuckMailTokenResponse {
  token: string;
}

interface DuckMailContact {
  address: string;
  name?: string;
}

interface DuckMailMessage {
  id: string;
  from?: DuckMailContact;
  to?: DuckMailContact[];
  subject?: string;
  intro?: string;
  text?: string;
  html?: string[] | string;
  createdAt?: string;
  updatedAt?: string;
  seen?: boolean;
  isDeleted?: boolean;
  hasAttachments?: boolean;
  size?: number;
  msgid?: string;
}

interface DuckMailMessagesResponse {
  'hydra:member'?: DuckMailMessage[];
}

export class DuckMailProvider implements IMailProvider {
  readonly name = 'duckmail';

  readonly capabilities: ChannelCapabilities = {
    createEmail: true,
    listEmails: true,
    getEmailContent: true,
    customDomains: true,
    customPrefix: true,
    emailExpiration: false,
    realTimeUpdates: false,
    attachmentSupport: true
  };

  private readonly baseUrl = 'https://api.duckmail.sbs';
  private readonly tokenStore = new Map<string, string>();

  private stats: ChannelStats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    averageResponseTime: 0,
    errorsToday: 0,
    requestsToday: 0
  };

  constructor(public readonly config: ChannelConfiguration) {}

  async initialize(config: ChannelConfiguration): Promise<void> {
    console.log('DuckMail provider initialized');
  }

  async createEmail(request: CreateEmailRequest): Promise<ChannelResponse<CreateEmailResponse>> {
    const startTime = Date.now();

    try {
      this.updateStats('request');

      const domains = await this.fetchAvailableDomains();
      const domain = request.domain && domains.includes(request.domain)
        ? request.domain
        : domains[Math.floor(Math.random() * domains.length)];

      const username = request.prefix || `dm${generateEmailPrefix(10)}`;
      const address = `${username}@${domain}`;
      const password = `${generateEmailPrefix(10)}Aa1!`;

      const createResponse = await httpClient.post(
        `${this.baseUrl}/accounts`,
        { address, password },
        {
          headers: {
            accept: 'application/json'
          },
          timeout: this.config.timeout,
          retries: this.config.retries
        }
      );

      if (!createResponse.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          `DuckMail create account failed: ${createResponse.status}`,
          createResponse.status
        );
      }

      const tokenResponse = await httpClient.post<DuckMailTokenResponse>(
        `${this.baseUrl}/token`,
        { address, password },
        {
          headers: {
            accept: 'application/json'
          },
          timeout: this.config.timeout,
          retries: this.config.retries
        }
      );

      if (!tokenResponse.ok || !tokenResponse.data.token) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          `DuckMail token request failed: ${tokenResponse.status}`,
          tokenResponse.status
        );
      }

      this.tokenStore.set(address, tokenResponse.data.token);

      const result: CreateEmailResponse = {
        address,
        domain,
        username,
        provider: this.name,
        accessToken: tokenResponse.data.token
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
        error: error instanceof Error
          ? error as ChannelError
          : this.createError(ChannelErrorType.UNKNOWN_ERROR, String(error)),
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

      const token = query.accessToken || this.tokenStore.get(query.address);
      if (!token) {
        throw this.createError(ChannelErrorType.AUTHENTICATION_ERROR, 'DuckMail requires an access token');
      }

      const response = await httpClient.get<DuckMailMessagesResponse>(`${this.baseUrl}/messages?page=1`, {
        headers: {
          Authorization: `Bearer ${token}`,
          accept: 'application/json'
        },
        timeout: this.config.timeout,
        retries: this.config.retries
      });

      if (!response.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          `DuckMail messages request failed: ${response.status} ${response.statusText}`,
          response.status
        );
      }

      let emails = (response.data['hydra:member'] || []).map(message => this.mapToEmailMessage(message, query.address));

      if (query.unreadOnly) {
        emails = emails.filter(email => !email.isRead);
      }

      if (query.since) {
        emails = emails.filter(email => email.receivedAt >= query.since!);
      }

      const limit = query.limit || 20;
      const offset = query.offset || 0;
      const paginatedEmails = emails.slice(offset, offset + limit);

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
        error: error instanceof Error
          ? error as ChannelError
          : this.createError(ChannelErrorType.UNKNOWN_ERROR, String(error)),
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

      const token = accessToken || this.tokenStore.get(emailAddress);
      if (!token) {
        throw this.createError(ChannelErrorType.AUTHENTICATION_ERROR, 'DuckMail requires an access token');
      }

      const response = await httpClient.get<DuckMailMessage>(`${this.baseUrl}/messages/${encodeURIComponent(emailId)}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          accept: 'application/json'
        },
        timeout: this.config.timeout,
        retries: this.config.retries
      });

      if (!response.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          `DuckMail message detail failed: ${response.status} ${response.statusText}`,
          response.status
        );
      }

      const email = this.mapToEmailMessage(response.data, emailAddress);

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
        error: error instanceof Error
          ? error as ChannelError
          : this.createError(ChannelErrorType.UNKNOWN_ERROR, String(error)),
        metadata: {
          provider: this.name,
          responseTime: Date.now() - startTime,
          requestId: generateId()
        }
      };
    }
  }

  async deleteEmail(emailAddress: string): Promise<ChannelResponse<boolean>> {
    this.tokenStore.delete(emailAddress);

    return {
      success: true,
      data: true,
      metadata: {
        provider: this.name,
        responseTime: 0,
        requestId: generateId()
      }
    };
  }

  async getHealth(): Promise<ChannelHealth> {
    const testResult = await this.testConnection();

    return {
      status: testResult.success ? ChannelStatus.ACTIVE : ChannelStatus.ERROR,
      lastChecked: new Date(),
      responseTime: testResult.metadata.responseTime,
      errorCount: this.stats.failedRequests,
      successRate: this.stats.totalRequests > 0
        ? (this.stats.successfulRequests / this.stats.totalRequests) * 100
        : 0,
      lastError: testResult.error?.message,
      uptime: this.stats.totalRequests > 0
        ? (this.stats.successfulRequests / this.stats.totalRequests) * 100
        : 100
    };
  }

  getStats(): ChannelStats {
    return { ...this.stats };
  }

  async testConnection(): Promise<ChannelResponse<boolean>> {
    const startTime = Date.now();

    try {
      const domains = await this.fetchAvailableDomains();
      const success = domains.length > 0;

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

  private async fetchAvailableDomains(): Promise<string[]> {
    const response = await httpClient.get<DuckMailDomainsResponse>(`${this.baseUrl}/domains`, {
      headers: {
        accept: 'application/json'
      },
      timeout: this.config.timeout,
      retries: this.config.retries
    });

    if (!response.ok) {
      throw this.createError(
        ChannelErrorType.API_ERROR,
        `DuckMail domains request failed: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    const domains = (response.data['hydra:member'] || [])
      .filter(domain => domain.domain && domain.isVerified !== false && domain.isActive !== false)
      .map(domain => domain.domain);

    if (!domains.length) {
      throw this.createError(ChannelErrorType.API_ERROR, 'DuckMail returned no usable domains');
    }

    return domains;
  }

  private mapToEmailMessage(message: DuckMailMessage, emailAddress: string): EmailMessage {
    const htmlContent = Array.isArray(message.html)
      ? message.html.map(item => String(item || '')).join('\n')
      : String(message.html || '');

    return {
      id: message.id,
      from: {
        email: message.from?.address || '',
        name: message.from?.name || undefined
      },
      to: (message.to || []).map(item => ({
        email: item.address,
        name: item.name || undefined
      })),
      subject: String(message.subject || ''),
      textContent: String(message.text || message.intro || ''),
      htmlContent,
      receivedAt: parseDate(String(message.createdAt || message.updatedAt || new Date().toISOString())),
      isRead: Boolean(message.seen),
      provider: this.name,
      messageId: message.msgid || undefined,
      size: typeof message.size === 'number' ? message.size : undefined,
      attachments: message.hasAttachments ? [] : undefined
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
        this.stats.averageResponseTime = (this.stats.averageResponseTime + responseTime) / 2;
      }
    } else if (type === 'error') {
      this.stats.failedRequests++;
      this.stats.errorsToday++;
    }
  }
}
