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
import type { HttpResponse } from '../utils/http-client.js';
import { generateId } from '../utils/helpers.js';
import { normalizeGenericEmailMessage } from './generic-provider-utils.js';
import { getRuntimeEnv } from '../runtime/env-store.js';

interface TempmailLolCreateResponse {
  address: string;
  token: string;
}

interface TempmailLolInboxResponse {
  emails?: Array<Record<string, unknown>>;
  expired?: boolean;
  error?: string;
  captcha_required?: boolean;
  note_a?: string;
  note_b?: string;
}

export class TempmailLolProvider implements IMailProvider {
  readonly name = 'tempmaillol';

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

  private readonly baseUrl = 'https://api.tempmail.lol/v2';
  private readonly publicFallbackProxyBase = 'https://api.codetabs.com/v1/proxy/?quest=';
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
    console.log('Tempmail.lol provider initialized');
  }

  async createEmail(request: CreateEmailRequest): Promise<ChannelResponse<CreateEmailResponse>> {
    const startTime = Date.now();

    try {
      this.updateStats('request');

      const payload = await this.requestJson<TempmailLolCreateResponse>(`${this.baseUrl}/inbox/create`);
      if (!payload.address || !payload.token) {
        throw this.createError(ChannelErrorType.API_ERROR, 'Tempmail.lol did not return address and token');
      }

      const [username, domain] = payload.address.split('@');
      this.tokenStore.set(payload.address, payload.token);

      const result: CreateEmailResponse = {
        address: payload.address,
        domain,
        username,
        provider: this.name,
        accessToken: payload.token
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
        throw this.createError(
          ChannelErrorType.AUTHENTICATION_ERROR,
          'Tempmail.lol requires an access token'
        );
      }

      const payload = await this.requestJson<TempmailLolInboxResponse>(
        `${this.baseUrl}/inbox?token=${encodeURIComponent(token)}`
      );

      if (payload.expired) {
        throw this.createError(ChannelErrorType.API_ERROR, 'Tempmail.lol mailbox expired');
      }

      const messages = Array.isArray(payload.emails) ? payload.emails : [];
      let emails = messages.map(message => normalizeGenericEmailMessage(message, this.name, query.address));

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
      accessToken,
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
      const payload = await this.requestJson<TempmailLolCreateResponse>(`${this.baseUrl}/inbox/create`);
      const success = Boolean(payload.address && payload.token);

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

  private async requestJson<T>(url: string): Promise<T> {
    const proxyConfig = this.getProxyConfig();
    let directResponse: HttpResponse<Record<string, unknown>> | null = null;
    let selfHostedProxyResponse: HttpResponse<Record<string, unknown>> | null = null;

    if (proxyConfig.baseUrl) {
      const proxyHeaders: Record<string, string> = {
        'x-tempmailhub-source': 'tempmaillol'
      };

      if (proxyConfig.sharedToken) {
        proxyHeaders['x-proxy-token'] = proxyConfig.sharedToken;
      }

      selfHostedProxyResponse = await this.tryRequest(
        this.buildProxyUrl(proxyConfig.baseUrl, url),
        proxyHeaders
      );

      if (selfHostedProxyResponse?.ok && !this.hasProviderLevelError(selfHostedProxyResponse.data)) {
        return selfHostedProxyResponse.data as T;
      }
    } else {
      directResponse = await this.tryRequest(url);
      if (directResponse?.ok && !this.hasProviderLevelError(directResponse.data)) {
        return directResponse.data as T;
      }

      if (!this.shouldUseProxyFallback(directResponse?.status, directResponse?.data)) {
        const message = this.extractErrorMessage(directResponse?.data) || `Tempmail.lol API request failed: ${directResponse?.status || 0}`;
        throw this.createError(ChannelErrorType.API_ERROR, message, directResponse?.status);
      }
    }

    const publicProxyResponse = await this.tryRequest(`${this.publicFallbackProxyBase}${encodeURIComponent(url)}`);
    if (!publicProxyResponse?.ok || this.hasProviderLevelError(publicProxyResponse.data)) {
      const message = this.extractErrorMessage(selfHostedProxyResponse?.data)
        || this.extractErrorMessage(publicProxyResponse?.data)
        || this.extractErrorMessage(directResponse?.data)
        || 'Tempmail.lol request failed via self-hosted proxy/direct path and CodeTabs fallback path';
      throw this.createError(
        ChannelErrorType.API_ERROR,
        message,
        selfHostedProxyResponse?.status || publicProxyResponse?.status || directResponse?.status
      );
    }

    return publicProxyResponse.data as T;
  }

  private async tryRequest(url: string, extraHeaders?: Record<string, string>) {
    try {
      return await httpClient.get<Record<string, unknown>>(url, {
        headers: {
          accept: 'application/json',
          ...extraHeaders
        },
        timeout: this.config.timeout,
        retries: 0
      });
    } catch (error) {
      return null;
    }
  }

  private hasProviderLevelError(payload?: Record<string, unknown> | null): boolean {
    if (!payload) {
      return false;
    }

    return Boolean(
      payload.error
      || payload.captcha_required
    );
  }

  private shouldUseProxyFallback(status?: number, payload?: Record<string, unknown> | null): boolean {
    if (status === 403 || status === 429 || !status) {
      return true;
    }

    const message = this.extractErrorMessage(payload).toLowerCase();
    return /captcha|required|banned|abuse|limit/.test(message);
  }

  private extractErrorMessage(payload?: Record<string, unknown> | null): string {
    if (!payload) {
      return '';
    }

    return [
      payload.error,
      payload.note_a,
      payload.note_b
    ]
      .filter(Boolean)
      .map(value => String(value))
      .join(' ')
      .trim();
  }

  private getProxyConfig(): { baseUrl?: string; sharedToken?: string } {
    const baseUrl = getRuntimeEnv('TEMPMAILLOL_PROXY_BASE_URL');
    const sharedToken = getRuntimeEnv('TEMPMAILLOL_PROXY_SHARED_TOKEN');

    return {
      baseUrl,
      sharedToken
    };
  }

  private buildProxyUrl(proxyBaseUrl: string, upstreamUrl: string): string {
    const normalizedBase = proxyBaseUrl.endsWith('/') ? proxyBaseUrl : `${proxyBaseUrl}/`;
    const upstream = new URL(upstreamUrl);
    return new URL(`${upstream.pathname.replace(/^\/+/, '')}${upstream.search}`, normalizedBase).toString();
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
