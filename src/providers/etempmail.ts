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
import { generateId, parseDate, stripHtml } from '../utils/helpers.js';

interface EtempMailAddressResponse {
  id: string;
  address: string;
  creation_time: string;
  recover_key: string;
}

interface EtempMailInboxMessage {
  subject: string;
  from: string;
  date: string;
  body: string;
}

interface EtempMailMailboxState {
  recoveryKey?: string;
  sessionId?: string;
  lisansimo?: string;
}

export class EtempMailProvider implements IMailProvider {
  readonly name = 'etempmail';

  readonly capabilities: ChannelCapabilities = {
    createEmail: true,
    listEmails: true,
    getEmailContent: true,
    customDomains: true,
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

  private readonly baseUrl = 'https://etempmail.com';
  private sessionId = '';
  private lisansimo = '';
  private readonly mailboxState = new Map<string, EtempMailMailboxState>();

  private readonly domainIdMapping: Record<string, string> = {
    'ohm.edu.pl': '21',
    'cross.edu.pl': '20',
    'usa.edu.pl': '19',
    'beta.edu.pl': '18'
  };

  constructor(public readonly config: ChannelConfiguration) {}

  async initialize(_config: ChannelConfiguration): Promise<void> {
    console.log('EtempMail provider initialized (real session cookies will be resolved on first use)');
  }

  async createEmail(request: CreateEmailRequest): Promise<ChannelResponse<CreateEmailResponse>> {
    const startTime = Date.now();

    try {
      this.updateStats('request');

      const mailboxSession = await this.bootstrapMailboxSession(request.domain);
      const response = await httpClient.post<EtempMailAddressResponse>(
        `${this.baseUrl}/getEmailAddress`,
        '',
        {
          headers: {
            ...this.buildBrowserHeaders('/'),
            ...(this.buildSessionCookieHeader(mailboxSession)
              ? { cookie: this.buildSessionCookieHeader(mailboxSession) }
              : {})
          },
          timeout: this.config.timeout,
          retries: this.config.retries
        }
      );

      if (!response.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          `EtempMail API returned ${response.status}: ${response.statusText}`,
          response.status
        );
      }

      const data = response.data;
      if (!data?.address) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          'Invalid response from EtempMail API: missing address'
        );
      }

      const nextSession = this.extractMailboxStateFromHeaders(response.headers, mailboxSession);
      this.applySessionState(nextSession);

      const [username, domain] = data.address.split('@');
      const creationTime = parseInt(String(data.creation_time || '0'), 10) * 1000;
      const expiresAt = new Date(creationTime + 15 * 60 * 1000);

      const result: CreateEmailResponse = {
        address: data.address,
        domain,
        username,
        expiresAt,
        provider: this.name,
        recoveryKey: data.recover_key,
        accessToken: this.buildMailboxAccessToken(
          data.recover_key || '',
          nextSession.sessionId || '',
          nextSession.lisansimo || ''
        )
      };

      this.rememberMailboxState(data.address, {
        recoveryKey: data.recover_key || '',
        sessionId: nextSession.sessionId || '',
        lisansimo: nextSession.lisansimo || ''
      });

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

      const mailboxSession = await this.ensureMailboxSession(query.address, query.accessToken);
      const response = await httpClient.post<EtempMailInboxMessage[]>(
        `${this.baseUrl}/getInbox`,
        '',
        {
          headers: {
            ...this.buildBrowserHeaders('/'),
            ...(this.buildSessionCookieHeader(mailboxSession)
              ? { cookie: this.buildSessionCookieHeader(mailboxSession) }
              : {})
          },
          timeout: this.config.timeout,
          retries: this.config.retries
        }
      );

      if (!response.ok) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          `EtempMail API returned ${response.status}: ${response.statusText}`,
          response.status
        );
      }

      const nextSession = this.extractMailboxStateFromHeaders(response.headers, mailboxSession);
      this.applySessionState(nextSession);
      this.rememberMailboxState(query.address, {
        recoveryKey: mailboxSession.recoveryKey || '',
        sessionId: nextSession.sessionId || mailboxSession.sessionId || '',
        lisansimo: nextSession.lisansimo || mailboxSession.lisansimo || ''
      });

      const messages = Array.isArray(response.data) ? response.data : [];
      const emails = messages.map((message, index) => this.mapToEmailMessage(message, query.address, index));

      let filteredEmails = emails;
      if (query.unreadOnly) {
        filteredEmails = filteredEmails.filter((email) => !email.isRead);
      }
      if (query.since) {
        filteredEmails = filteredEmails.filter((email) => email.receivedAt >= query.since!);
      }

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
    const emailsResponse = await this.getEmails({
      address: emailAddress,
      accessToken
    });

    if (!emailsResponse.success) {
      return {
        success: false,
        error: emailsResponse.error,
        metadata: emailsResponse.metadata
      };
    }

    const email = emailsResponse.data?.find((message) => message.id === emailId);
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
      const response = await httpClient.post(`${this.baseUrl}/getServerTime`, '', {
        headers: this.buildBrowserHeaders('/'),
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

  private buildBrowserHeaders(refererPath = '/', extraHeaders: Record<string, string> = {}): Record<string, string> {
    return {
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      origin: this.baseUrl,
      referer: `${this.baseUrl}${refererPath}`,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      'x-requested-with': 'XMLHttpRequest',
      ...extraHeaders
    };
  }

  private rememberMailboxState(address: string, state: EtempMailMailboxState): void {
    if (!address) {
      return;
    }

    const current = this.mailboxState.get(address) || {};
    this.mailboxState.set(address, {
      recoveryKey: state.recoveryKey || current.recoveryKey || '',
      sessionId: state.sessionId || current.sessionId || '',
      lisansimo: state.lisansimo || current.lisansimo || ''
    });
  }

  private parseMailboxToken(accessToken?: string): EtempMailMailboxState {
    const raw = String(accessToken || '').trim();
    if (!raw) {
      return { recoveryKey: '', sessionId: '', lisansimo: '' };
    }

    if (raw.includes('|')) {
      const parsed: EtempMailMailboxState = {
        recoveryKey: '',
        sessionId: '',
        lisansimo: ''
      };
      for (const part of raw.split('|').map((item) => item.trim()).filter(Boolean)) {
        if (part.startsWith('rk=')) {
          parsed.recoveryKey = part.slice(3).trim();
        } else if (part.startsWith('sid=')) {
          parsed.sessionId = part.slice(4).trim();
        } else if (part.startsWith('ls=')) {
          parsed.lisansimo = part.slice(3).trim();
        }
      }
      if (parsed.recoveryKey || parsed.sessionId || parsed.lisansimo) {
        return parsed;
      }
    }

    if (/^[a-z0-9]{24,64}$/.test(raw) && raw === raw.toLowerCase()) {
      return { recoveryKey: '', sessionId: raw, lisansimo: '' };
    }

    return { recoveryKey: raw, sessionId: '', lisansimo: '' };
  }

  private buildMailboxAccessToken(recoveryKey = '', sessionId = '', lisansimo = ''): string {
    const parts: string[] = [];
    if (recoveryKey) {
      parts.push(`rk=${recoveryKey}`);
    }
    if (sessionId) {
      parts.push(`sid=${sessionId}`);
    }
    if (lisansimo) {
      parts.push(`ls=${lisansimo}`);
    }
    return parts.join('|') || sessionId || recoveryKey || '';
  }

  private async bootstrapMailboxSession(preferredDomain?: string): Promise<EtempMailMailboxState> {
    const domainId = this.pickDomainId(preferredDomain);
    return this.changeEmailAddress(domainId);
  }

  private pickDomainId(preferredDomain?: string): string {
    if (preferredDomain && this.domainIdMapping[preferredDomain]) {
      return this.domainIdMapping[preferredDomain];
    }

    const domainIds = Object.values(this.domainIdMapping);
    return domainIds[Math.floor(Math.random() * domainIds.length)];
  }

  private async recoverMailboxByKey(recoveryKey: string): Promise<EtempMailMailboxState> {
    if (!recoveryKey) {
      throw this.createError(ChannelErrorType.AUTHENTICATION_ERROR, 'EtempMail requires a recovery key');
    }

    const response = await httpClient.post(
      `${this.baseUrl}/recoverEmailAddress`,
      `key=${encodeURIComponent(recoveryKey)}`,
      {
        headers: this.buildBrowserHeaders('/', {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
        }),
        timeout: this.config.timeout,
        retries: this.config.retries
      }
    );

    if (!response.ok) {
      throw this.createError(
        ChannelErrorType.API_ERROR,
        `EtempMail recover mailbox failed: ${response.status}: ${response.statusText}`,
        response.status
      );
    }

    const nextSession = this.extractMailboxStateFromHeaders(response.headers);
    if (!nextSession.sessionId) {
      throw this.createError(
        ChannelErrorType.AUTHENTICATION_ERROR,
        'EtempMail recovery did not return a valid session'
      );
    }

    this.applySessionState(nextSession);
    return nextSession;
  }

  private async ensureMailboxSession(address: string, accessToken?: string): Promise<EtempMailMailboxState> {
    const parsed = this.parseMailboxToken(accessToken);
    const stored = this.mailboxState.get(address) || {};
    const recoveryKey = parsed.recoveryKey || stored.recoveryKey || '';
    const sessionId = parsed.sessionId || stored.sessionId || '';
    const lisansimo = parsed.lisansimo || stored.lisansimo || '';

    if (recoveryKey) {
      const restored = await this.recoverMailboxByKey(recoveryKey);
      const mergedState = {
        recoveryKey,
        sessionId: restored.sessionId || sessionId,
        lisansimo: restored.lisansimo || lisansimo
      };
      this.rememberMailboxState(address, mergedState);
      return mergedState;
    }

    if (sessionId || lisansimo) {
      const mergedState = { recoveryKey, sessionId, lisansimo };
      this.applySessionState(mergedState);
      this.rememberMailboxState(address, mergedState);
      return mergedState;
    }

    throw this.createError(
      ChannelErrorType.AUTHENTICATION_ERROR,
      'EtempMail requires a recovery key or valid mailbox session'
    );
  }

  private async changeEmailAddress(domainId: string): Promise<EtempMailMailboxState> {
    const response = await httpClient.post(
      `${this.baseUrl}/changeEmailAddress`,
      `id=${encodeURIComponent(domainId)}`,
      {
        headers: {
          ...this.buildBrowserHeaders('/zh', {
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'cache-control': 'max-age=0',
            'content-type': 'application/x-www-form-urlencoded',
            'upgrade-insecure-requests': '1'
          }),
          ...(this.buildSessionCookieHeader({ sessionId: this.sessionId, lisansimo: this.lisansimo })
            ? { cookie: this.buildSessionCookieHeader({ sessionId: this.sessionId, lisansimo: this.lisansimo }) }
            : {})
        },
        redirect: 'manual',
        timeout: this.config.timeout
      }
    );

    if (!(response.ok || response.status === 301 || response.status === 307)) {
      throw this.createError(
        ChannelErrorType.API_ERROR,
        `EtempMail domain bootstrap failed: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    const nextSession = this.extractMailboxStateFromHeaders(response.headers, {
      sessionId: this.sessionId,
      lisansimo: this.lisansimo
    });
    if (!nextSession.sessionId) {
      throw this.createError(
        ChannelErrorType.AUTHENTICATION_ERROR,
        'EtempMail domain bootstrap did not return a valid session'
      );
    }

    this.applySessionState(nextSession);
    return nextSession;
  }

  private extractMailboxStateFromHeaders(headers: Headers, fallback: EtempMailMailboxState = {}): EtempMailMailboxState {
    return {
      recoveryKey: fallback.recoveryKey || '',
      sessionId: this.extractCookieValue(headers, 'ci_session') || fallback.sessionId || '',
      lisansimo: this.extractCookieValue(headers, 'lisansimo') || fallback.lisansimo || ''
    };
  }

  private applySessionState(state: EtempMailMailboxState): void {
    this.sessionId = state.sessionId || '';
    this.lisansimo = state.lisansimo || '';
  }

  private buildSessionCookieHeader(state: EtempMailMailboxState = {}): string {
    const cookies = [
      state.sessionId ? `ci_session=${state.sessionId}` : '',
      state.lisansimo ? `lisansimo=${state.lisansimo}` : ''
    ].filter(Boolean);
    return cookies.join('; ');
  }

  private extractCookieValue(headers: Headers, cookieName: string): string {
    const typedHeaders = headers as Headers & {
      getSetCookie?: () => string[];
    };
    const rawValues = typeof typedHeaders.getSetCookie === 'function'
      ? typedHeaders.getSetCookie()
      : [headers.get('set-cookie') || ''];
    const pattern = new RegExp(`${this.escapeRegExp(cookieName)}=([^;,]+)`);

    for (const rawValue of rawValues) {
      const match = String(rawValue || '').match(pattern);
      if (match?.[1]) {
        return String(match[1]).trim();
      }
    }

    return '';
  }

  private escapeRegExp(value: string): string {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private mapToEmailMessage(message: EtempMailInboxMessage, emailAddress: string, index: number): EmailMessage {
    return {
      id: String(index),
      from: {
        email: message.from
      },
      to: [{
        email: emailAddress
      }],
      subject: message.subject,
      textContent: stripHtml(message.body),
      htmlContent: message.body,
      receivedAt: parseDate(message.date),
      isRead: false,
      provider: this.name,
      size: message.body.length
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
    this.stats.totalRequests += 1;
    this.stats.requestsToday += 1;
    this.stats.lastRequestTime = new Date();

    if (type === 'success') {
      this.stats.successfulRequests += 1;
      if (responseTime) {
        this.stats.averageResponseTime =
          this.stats.averageResponseTime > 0
            ? (this.stats.averageResponseTime + responseTime) / 2
            : responseTime;
      }
      return;
    }

    if (type === 'error') {
      this.stats.failedRequests += 1;
      this.stats.errorsToday += 1;
    }
  }
}
