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
import { generateId } from '../utils/helpers.js';
import { normalizeGenericEmailMessage } from './generic-provider-utils.js';

interface YYDSMailCreatePayload {
  address?: string;
  createdAt?: string;
  expiresAt?: string;
  id?: string;
  inboxType?: string;
  isActive?: boolean;
  source?: string;
  token?: string;
}

interface YYDSMailCreateResponse {
  success?: boolean;
  data?: YYDSMailCreatePayload;
  error?: string;
  errorCode?: string;
}

interface YYDSMailMessageListResponse {
  success?: boolean;
  data?: {
    messages?: Array<Record<string, unknown>>;
    total?: number;
  };
  error?: string;
  errorCode?: string;
}

interface YYDSMailMessageDetailResponse {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
}

export class YYDSMailProvider implements IMailProvider {
  readonly name = 'yydsmail';

  readonly capabilities: ChannelCapabilities = {
    createEmail: true,
    listEmails: true,
    getEmailContent: true,
    customDomains: false,
    customPrefix: false,
    emailExpiration: true,
    realTimeUpdates: false,
    attachmentSupport: true
  };

  private readonly createUrl = 'https://vip.215.im/api/temp-inbox';
  private readonly apiBaseUrl = 'https://vip.215.im/v1';
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
    console.log('YYDS Mail provider initialized');
  }

  async createEmail(request: CreateEmailRequest): Promise<ChannelResponse<CreateEmailResponse>> {
    const startTime = Date.now();

    try {
      this.updateStats('request');

      const response = await httpClient.post<YYDSMailCreateResponse>(
        this.createUrl,
        undefined,
        {
          headers: this.buildPublicHeaders(),
          timeout: this.config.timeout,
          retries: this.config.retries
        }
      );

      if (!response.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          this.buildApiErrorMessage('YYDS Mail create failed', response.data?.error, response.status),
          response.status
        );
      }

      const payload = response.data?.data;
      const address = payload?.address || '';
      const token = payload?.token || '';

      if (!response.data?.success || !address || !token) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          response.data?.error || 'YYDS Mail did not return a valid mailbox address/token'
        );
      }

      this.tokenStore.set(address, token);

      const [username, domain] = address.split('@');
      const result: CreateEmailResponse = {
        address,
        domain,
        username,
        expiresAt: payload?.expiresAt ? new Date(payload.expiresAt) : undefined,
        provider: this.name,
        accessToken: token
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
        throw this.createError(ChannelErrorType.AUTHENTICATION_ERROR, 'YYDS Mail requires an access token');
      }

      const url = `${this.apiBaseUrl}/messages?address=${encodeURIComponent(query.address)}`;
      const response = await httpClient.get<YYDSMailMessageListResponse>(url, {
        headers: this.buildAuthorizedHeaders(token),
        timeout: this.config.timeout,
        retries: this.config.retries
      });

      if (!response.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          this.buildApiErrorMessage('YYDS Mail inbox request failed', response.data?.error, response.status),
          response.status
        );
      }

      if (response.data?.success === false) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          response.data.error || 'YYDS Mail returned an unsuccessful inbox response'
        );
      }

      let emails = (response.data?.data?.messages || []).map((message) =>
        normalizeGenericEmailMessage(message, this.name, query.address)
      );

      if (query.unreadOnly) {
        emails = emails.filter((email) => !email.isRead);
      }

      if (query.since) {
        emails = emails.filter((email) => email.receivedAt >= query.since!);
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
        throw this.createError(ChannelErrorType.AUTHENTICATION_ERROR, 'YYDS Mail requires an access token');
      }

      const response = await httpClient.get<YYDSMailMessageDetailResponse>(
        `${this.apiBaseUrl}/messages/${encodeURIComponent(emailId)}`,
        {
          headers: this.buildAuthorizedHeaders(token),
          timeout: this.config.timeout,
          retries: this.config.retries
        }
      );

      if (response.ok && response.data?.success !== false && response.data?.data) {
        const email = normalizeGenericEmailMessage(response.data.data, this.name, emailAddress);

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
      }

      const listResponse = await this.getEmails({
        address: emailAddress,
        accessToken: token,
        limit: 100,
        offset: 0
      });

      if (!listResponse.success || !listResponse.data) {
        return {
          success: false,
          error: listResponse.error,
          metadata: listResponse.metadata
        };
      }

      const email = listResponse.data.find((item) => item.id === emailId);
      if (!email) {
        throw this.createError(ChannelErrorType.API_ERROR, `Email with ID ${emailId} not found`);
      }

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
      const createResponse = await this.createEmail({});
      const success = Boolean(createResponse.success && createResponse.data?.address && createResponse.data?.accessToken);

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

  private buildPublicHeaders(): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://vip.215.im',
      Referer: 'https://vip.215.im/',
      'X-Locale': 'zh'
    };
  }

  private buildAuthorizedHeaders(token: string): Record<string, string> {
    return {
      ...this.buildPublicHeaders(),
      Authorization: `Bearer ${token}`
    };
  }

  private buildApiErrorMessage(prefix: string, apiError?: string, statusCode?: number): string {
    return apiError ? `${prefix}: ${apiError}` : `${prefix}: ${statusCode || 'unknown status'}`;
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
