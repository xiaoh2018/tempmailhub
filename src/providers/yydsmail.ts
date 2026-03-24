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
import { delay, generateEmailPrefix, generateId } from '../utils/helpers.js';
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

interface YYDSMailDomainPayload {
  domain?: string;
  isPublic?: boolean;
  isVerified?: boolean;
}

interface YYDSMailDomainsResponse {
  success?: boolean;
  data?: YYDSMailDomainPayload[];
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
    customDomains: true,
    customPrefix: true,
    emailExpiration: true,
    realTimeUpdates: false,
    attachmentSupport: true
  };

  private readonly createUrl = 'https://vip.215.im/api/temp-inbox';
  private readonly apiBaseUrl = 'https://vip.215.im/v1';
  private readonly domainsUrl = `${this.apiBaseUrl}/domains`;
  private readonly tokenStore = new Map<string, string>();
  private readonly mailboxMetaStore = new Map<string, { token: string; createdAt: number }>();
  private readonly preferredDomains = [
    '0m0.email',
    '0m0.app',
    'mali.215.im',
    'hblinhe.cn',
    'codinggo.cn',
    'aifenxiao.cc',
    'mail.ojason.top',
    'xiaolajiao.tech',
    '1m1.dpdns.org',
    'xiaolajiao.de'
  ];
  private readonly discouragedDomainMarkers = [
    '.qzz.io',
    '.us.ci',
    '.cc.cd',
    '.eu.cc',
    '.ggff.net',
    '.dpdns.org',
    '.de5.net',
    '.dedyn.io',
    '.elementfx.com'
  ];
  private readonly retryDelaysForFreshInboxMs = [900, 1800];
  private readonly retryDelaysForExistingInboxMs = [900];
  private domainCache: {
    values: string[];
    expiresAt: number;
    pending: Promise<string[]> | null;
  } = {
    values: [],
    expiresAt: 0,
    pending: null
  };
  private domainCursor = 0;

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

      const availableDomains = await this.fetchAvailableDomains();
      const domain = this.pickDomain(availableDomains, request.domain);
      const username = this.resolveUsername(request.prefix);
      const address = `${username}@${domain}`;

      const response = await httpClient.post<YYDSMailCreateResponse>(
        this.createUrl,
        {
          domain,
          address
        },
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
      const createdAddress = payload?.address || '';
      const token = payload?.token || '';

      if (!response.data?.success || !createdAddress || !token) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          response.data?.error || 'YYDS Mail did not return a valid mailbox address/token'
        );
      }

      this.rememberMailbox(createdAddress, token);

      const [createdUsername, createdDomain] = createdAddress.split('@');
      const result: CreateEmailResponse = {
        address: createdAddress,
        domain: createdDomain,
        username: createdUsername,
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

      this.rememberMailbox(query.address, token);

      let rawMessages = await this.fetchInboxMessages(query.address, token);
      if (!rawMessages.length) {
        const retryDelays = this.getEmptyInboxRetryDelays(query.address);
        for (const retryDelay of retryDelays) {
          await delay(retryDelay);
          rawMessages = await this.fetchInboxMessages(query.address, token);
          if (rawMessages.length) {
            break;
          }
        }
      }

      let emails = rawMessages.map((message) =>
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

      this.rememberMailbox(emailAddress, token);

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

  private async fetchAvailableDomains(): Promise<string[]> {
    const now = Date.now();
    if (this.domainCache.values.length && this.domainCache.expiresAt > now) {
      return this.domainCache.values;
    }

    if (this.domainCache.pending) {
      return this.domainCache.pending;
    }

    this.domainCache.pending = (async () => {
      const response = await httpClient.get<YYDSMailDomainsResponse>(this.domainsUrl, {
        headers: this.buildPublicHeaders(),
        timeout: this.config.timeout,
        retries: this.config.retries
      });

      if (!response.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          this.buildApiErrorMessage('YYDS Mail domains request failed', response.data?.error, response.status),
          response.status
        );
      }

      const domains = [...new Set(
        (Array.isArray(response.data?.data) ? response.data?.data : [])
          .filter((item) => item?.domain && item.isPublic !== false && item.isVerified !== false)
          .map((item) => String(item.domain).trim().toLowerCase())
          .filter(Boolean)
      )];

      if (!domains.length) {
        throw this.createError(ChannelErrorType.API_ERROR, 'YYDS Mail returned no usable public domains');
      }

      domains.sort((left, right) => this.scoreDomain(right) - this.scoreDomain(left) || left.localeCompare(right));
      this.domainCache.values = domains;
      this.domainCache.expiresAt = Date.now() + 10 * 60 * 1000;
      return domains;
    })().finally(() => {
      this.domainCache.pending = null;
    });

    return this.domainCache.pending;
  }

  private scoreDomain(domain: string): number {
    const value = String(domain || '').trim().toLowerCase();
    if (!value) {
      return Number.NEGATIVE_INFINITY;
    }

    let score = 0;
    const exactIndex = this.preferredDomains.indexOf(value);
    if (exactIndex >= 0) {
      score += 500 - exactIndex * 10;
    }

    const suffixScores: Array<[string, number]> = [
      ['.email', 80],
      ['.app', 72],
      ['.cn', 64],
      ['.im', 58],
      ['.top', 42],
      ['.tech', 40],
      ['.org', 32],
      ['.com', 28],
      ['.de', 24],
      ['.cfd', 16]
    ];
    suffixScores.forEach(([suffix, valueScore]) => {
      if (value.endsWith(suffix)) {
        score += valueScore;
      }
    });

    if (value.includes('215.im')) {
      score += 28;
    }

    if (/^\d/.test(value)) {
      score -= 90;
    }
    if (/\d{5,}/.test(value)) {
      score -= 48;
    }
    if (value.split('.').some((part) => /^\d+$/.test(part))) {
      score -= 18;
    }

    this.discouragedDomainMarkers.forEach((marker) => {
      if (value.includes(marker)) {
        score -= 35;
      }
    });

    if (value.length <= 12) {
      score += 8;
    } else if (value.length >= 24) {
      score -= 8;
    }

    return score;
  }

  private pickDomain(domains: string[], requestedDomain?: string): string {
    const normalizedRequestedDomain = String(requestedDomain || '').trim().toLowerCase();
    if (normalizedRequestedDomain) {
      if (!domains.includes(normalizedRequestedDomain)) {
        throw this.createError(
          ChannelErrorType.CONFIGURATION_ERROR,
          `YYDS Mail domain is unavailable: ${normalizedRequestedDomain}`
        );
      }
      return normalizedRequestedDomain;
    }

    const preferredPool = domains.filter((domain) => this.scoreDomain(domain) >= 24).slice(0, 10);
    const rotationPool = preferredPool.length ? preferredPool : domains;
    const domain = rotationPool[this.domainCursor % rotationPool.length];
    this.domainCursor = (this.domainCursor + 1) % Math.max(rotationPool.length, 1);
    return domain;
  }

  private resolveUsername(prefix?: string): string {
    const normalized = String(prefix || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 24);

    return normalized || `yd${generateEmailPrefix(10)}`;
  }

  private rememberMailbox(address: string, token: string): void {
    if (!address || !token) {
      return;
    }
    this.tokenStore.set(address, token);
    const createdAt = this.mailboxMetaStore.get(address)?.createdAt || Date.now();
    this.mailboxMetaStore.set(address, {
      token,
      createdAt
    });
  }

  private getEmptyInboxRetryDelays(address: string): number[] {
    const createdAt = this.mailboxMetaStore.get(address)?.createdAt || 0;
    if (!createdAt) {
      return this.retryDelaysForExistingInboxMs;
    }

    const mailboxAgeMs = Date.now() - createdAt;
    if (mailboxAgeMs <= 3 * 60 * 1000) {
      return this.retryDelaysForFreshInboxMs;
    }

    if (mailboxAgeMs <= 30 * 60 * 1000) {
      return this.retryDelaysForExistingInboxMs;
    }

    return [];
  }

  private async fetchInboxMessages(address: string, token: string): Promise<Array<Record<string, unknown>>> {
    const url = `${this.apiBaseUrl}/messages?address=${encodeURIComponent(address)}`;
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

    return (response.data?.data?.messages || []).filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object')
    );
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
