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

interface TempmailIngCreateResponse {
  email?: {
    address?: string;
  } | string;
}

interface TempmailIngInboxResponse {
  emails?: Array<Record<string, unknown>>;
  success?: boolean;
}

export class TempmailIngProvider implements IMailProvider {
  readonly name = 'tempmailing';

  readonly capabilities: ChannelCapabilities = {
    createEmail: true,
    listEmails: true,
    getEmailContent: true,
    customDomains: false,
    customPrefix: false,
    emailExpiration: false,
    realTimeUpdates: false,
    attachmentSupport: true
  };

  private readonly baseUrl = 'https://api.tempmail.ing/api';

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
    console.log('Tempmail.ing provider initialized');
  }

  async createEmail(request: CreateEmailRequest): Promise<ChannelResponse<CreateEmailResponse>> {
    const startTime = Date.now();

    try {
      this.updateStats('request');

      const response = await httpClient.post<TempmailIngCreateResponse>(
        `${this.baseUrl}/generate`,
        '',
        {
          headers: {
            accept: 'application/json'
          },
          timeout: this.config.timeout,
          retries: this.config.retries
        }
      );

      if (!response.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          `Tempmail.ing create failed: ${response.status} ${response.statusText}`,
          response.status
        );
      }

      const address = typeof response.data.email === 'string'
        ? response.data.email
        : response.data.email?.address || '';

      if (!address) {
        throw this.createError(ChannelErrorType.API_ERROR, 'Tempmail.ing did not return an address');
      }

      const [username, domain] = address.split('@');
      const result: CreateEmailResponse = {
        address,
        domain,
        username,
        provider: this.name
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

      const response = await httpClient.get<TempmailIngInboxResponse>(
        `${this.baseUrl}/emails/${encodeURIComponent(query.address)}`,
        {
          headers: {
            accept: 'application/json'
          },
          timeout: this.config.timeout,
          retries: this.config.retries
        }
      );

      if (!response.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          `Tempmail.ing inbox request failed: ${response.status} ${response.statusText}`,
          response.status
        );
      }

      const data = response.data;
      if (data.success === false) {
        throw this.createError(ChannelErrorType.API_ERROR, 'Tempmail.ing returned unsuccessful inbox response');
      }

      let emails = (data.emails || []).map(message => normalizeGenericEmailMessage(message, this.name, query.address));

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
    const listResponse = await this.getEmails({
      address: emailAddress,
      limit: 100,
      offset: 0
    });

    if (!listResponse.success) {
      return {
        success: false,
        error: listResponse.error,
        metadata: listResponse.metadata
      };
    }

    const email = listResponse.data?.find(item => item.id === emailId);
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
      const createResponse = await httpClient.post<TempmailIngCreateResponse>(
        `${this.baseUrl}/generate`,
        '',
        {
          headers: {
            accept: 'application/json'
          },
          timeout: this.config.timeout,
          retries: 0
        }
      );

      const address = typeof createResponse.data.email === 'string'
        ? createResponse.data.email
        : createResponse.data.email?.address || '';

      const success = createResponse.ok && Boolean(address);

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
