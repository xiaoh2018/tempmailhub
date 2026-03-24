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

interface GptMailBrowserAuth {
  token?: string;
  email?: string;
  expires_at?: number;
}

interface GptMailUpstreamAuth {
  token?: string;
  email?: string;
  expires_at?: number;
}

interface GptMailCreatePayload {
  success?: boolean;
  data?: {
    email?: string;
  };
  auth?: GptMailUpstreamAuth;
  error?: string;
  message?: string;
}

interface GptMailInboxItem {
  id?: string | number;
  from_address?: string;
  from_name?: string;
  from?: string;
  subject?: string;
  content?: string;
  text?: string;
  html?: string;
  timestamp?: string | number;
  date?: string;
  created_at?: string;
}

interface GptMailInboxPayload {
  success?: boolean;
  data?: {
    emails?: GptMailInboxItem[];
    count?: number;
  };
  auth?: GptMailUpstreamAuth;
  error?: string;
  message?: string;
}

interface GptMailRefreshPayload {
  success?: boolean;
  auth?: GptMailUpstreamAuth;
  data?: {
    auth?: GptMailUpstreamAuth;
  };
  error?: string;
  message?: string;
}

interface GptMailSessionState {
  token: string;
  gmSid: string;
  email: string;
  expiresAt: number;
}

interface GptMailRequestOptions {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  expectedContentType?: 'json' | 'text';
  mailboxAddress?: string;
}

const GPTMAIL_BASE_URL = 'https://mail.chatgpt.org.uk';
const GPTMAIL_HOME_PATH = '/zh/';
const GPTMAIL_TOKEN_PREFIX = 'gptmail.';
const GPTMAIL_REFRESH_BUFFER_SECONDS = 60;
const GPTMAIL_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

export class GptMailProvider implements IMailProvider {
  readonly name = 'gptmail';

  readonly capabilities: ChannelCapabilities = {
    createEmail: true,
    listEmails: true,
    getEmailContent: true,
    customDomains: true,
    customPrefix: true,
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

  private readonly mailboxSessions = new Map<string, GptMailSessionState>();
  private connectionTested = false;
  private connectionTestResult: { success: boolean; error?: string; testedAt: Date } | null = null;

  constructor(public readonly config: ChannelConfiguration) {}

  async initialize(_config: ChannelConfiguration): Promise<void> {
    console.log('GPTMail provider initialized (browser auth session will be resolved on first use)');
  }

  async createEmail(request: CreateEmailRequest): Promise<ChannelResponse<CreateEmailResponse>> {
    const startTime = Date.now();

    try {
      this.updateStats('request');

      const initialSession = await this.createBrowserSession();
      const payload = {
        ...(request.prefix ? { prefix: String(request.prefix).trim() || generateEmailPrefix(10) } : {}),
        ...(request.domain ? { domain: String(request.domain).trim() } : {})
      };

      const response = await this.requestUpstream<GptMailCreatePayload>(
        '/api/generate-email',
        {
          method: Object.keys(payload).length ? 'POST' : 'GET',
          body: Object.keys(payload).length ? JSON.stringify(payload) : undefined,
          headers: {
            ...(Object.keys(payload).length ? { 'content-type': 'application/json' } : {})
          }
        },
        initialSession
      );

      this.ensureUpstreamSuccess(response.data, response.status);

      const address = String(response.data?.data?.email || '').trim();
      if (!address) {
        throw this.createError(
          ChannelErrorType.API_ERROR,
          'GPTMail did not return a mailbox address'
        );
      }

      const nextSession = this.mergeSessionState(
        { ...initialSession, email: address },
        response.data?.auth,
        response.headers,
        address
      );

      this.rememberMailboxSession(address, nextSession);

      const [username, domain] = address.split('@');
      const result: CreateEmailResponse = {
        address,
        domain,
        username,
        provider: this.name,
        accessToken: this.serializeSessionState(nextSession),
        expiresAt: new Date(nextSession.expiresAt * 1000)
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

      const address = String(query.address || '').trim();
      if (!address) {
        throw this.createError(ChannelErrorType.API_ERROR, 'GPTMail requires email address');
      }

      let session = await this.resolveMailboxSession(address, query.accessToken);
      let response;

      try {
        response = await this.requestUpstream<GptMailInboxPayload>(
          `/api/emails?email=${encodeURIComponent(address)}`,
          { method: 'GET' },
          session
        );
      } catch (error) {
        const statusCode = Number((error as ChannelError)?.statusCode || 0);
        if (statusCode === 401 || statusCode === 403) {
          session = await this.refreshMailboxSession(session, address);
          response = await this.requestUpstream<GptMailInboxPayload>(
            `/api/emails?email=${encodeURIComponent(address)}`,
            { method: 'GET' },
            session
          );
        } else {
          throw error;
        }
      }

      this.ensureUpstreamSuccess(response.data, response.status);

      const nextSession = this.mergeSessionState(session, response.data?.auth, response.headers, address);
      this.rememberMailboxSession(address, nextSession);

      const messages = Array.isArray(response.data?.data?.emails) ? response.data.data.emails : [];
      const emails = messages
        .map((message) => this.mapInboxItemToEmail(message, address))
        .filter((message) => Boolean(message.id));

      const filtered = emails
        .filter((email) => (query.unreadOnly ? !email.isRead : true))
        .filter((email) => (query.since ? email.receivedAt >= query.since : true));

      const limit = query.limit || 20;
      const offset = query.offset || 0;
      const paginated = filtered.slice(offset, offset + limit);

      this.updateStats('success', Date.now() - startTime);

      return {
        success: true,
        data: paginated,
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
    const response = await this.getEmails({
      address: emailAddress,
      accessToken,
      limit: 50
    });

    if (!response.success) {
      return {
        success: false,
        error: response.error,
        metadata: response.metadata
      };
    }

    const message = response.data?.find((item) => String(item.id) === String(emailId));
    if (!message) {
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
      data: message,
      metadata: {
        provider: this.name,
        responseTime: 0,
        requestId: generateId()
      }
    };
  }

  async getHealth(): Promise<ChannelHealth> {
    if (!this.connectionTested) {
      await this.ensureConnectionTested();
    }

    const result = this.connectionTestResult || {
      success: false,
      error: 'GPTMail connection not tested',
      testedAt: new Date()
    };

    return {
      status: result.success ? ChannelStatus.ACTIVE : ChannelStatus.ERROR,
      lastChecked: result.testedAt,
      responseTime: 0,
      errorCount: this.stats.failedRequests,
      successRate: this.stats.totalRequests > 0
        ? (this.stats.successfulRequests / this.stats.totalRequests) * 100
        : 0,
      lastError: result.error,
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
      const session = await this.createBrowserSession();

      return {
        success: Boolean(session.token && session.gmSid),
        data: Boolean(session.token && session.gmSid),
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

  private async ensureConnectionTested(): Promise<void> {
    if (this.connectionTested) {
      return;
    }

    try {
      const result = await this.testConnection();
      this.connectionTestResult = {
        success: result.success,
        error: result.error?.message,
        testedAt: new Date()
      };
    } catch (error) {
      this.connectionTestResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        testedAt: new Date()
      };
    } finally {
      this.connectionTested = true;
    }
  }

  private async createBrowserSession(): Promise<GptMailSessionState> {
    const response = await httpClient.get<string>(`${GPTMAIL_BASE_URL}${GPTMAIL_HOME_PATH}`, {
      headers: this.buildBrowserHeaders({
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }),
      timeout: this.config.timeout,
      retries: this.config.retries
    });

    if (!response.ok) {
      throw this.createError(
        ChannelErrorType.NETWORK_ERROR,
        `GPTMail homepage returned ${response.status}`,
        response.status
      );
    }

    const html = this.responseBodyToText(response.data);
    const browserAuth = this.extractBrowserAuth(html);
    const gmSid = this.extractCookieValue(response.headers, 'gm_sid');

    if (!browserAuth.token || !gmSid) {
      throw this.createError(
        ChannelErrorType.AUTHENTICATION_ERROR,
        'GPTMail homepage did not return browser auth token or gm_sid cookie'
      );
    }

    return {
      token: browserAuth.token,
      gmSid,
      email: String(browserAuth.email || '').trim(),
      expiresAt: Number(browserAuth.expires_at || Math.floor(Date.now() / 1000) + 300)
    };
  }

  private async resolveMailboxSession(address: string, accessToken?: string): Promise<GptMailSessionState> {
    const decoded = this.deserializeSessionState(accessToken);
    const stored = this.mailboxSessions.get(address);
    const merged = this.chooseBestSession(address, decoded, stored);

    if (!merged) {
      throw this.createError(
        ChannelErrorType.AUTHENTICATION_ERROR,
        'GPTMail requires accessToken generated by this service'
      );
    }

    const normalized: GptMailSessionState = {
      ...merged,
      email: address
    };

    const nextSession = this.needsRefresh(normalized)
      ? await this.refreshMailboxSession(normalized, address)
      : normalized;

    this.rememberMailboxSession(address, nextSession);
    return nextSession;
  }

  private chooseBestSession(
    address: string,
    decoded?: GptMailSessionState | null,
    stored?: GptMailSessionState | null
  ): GptMailSessionState | null {
    const candidates = [decoded, stored]
      .filter((item): item is GptMailSessionState => Boolean(item?.token && item?.gmSid))
      .map((item) => ({
        ...item,
        email: address || item.email
      }));

    if (!candidates.length) {
      return null;
    }

    candidates.sort((left, right) => Number(right.expiresAt || 0) - Number(left.expiresAt || 0));
    return candidates[0];
  }

  private async refreshMailboxSession(session: GptMailSessionState, address: string): Promise<GptMailSessionState> {
    const response = await this.requestUpstream<GptMailRefreshPayload>(
      '/api/inbox-token',
        {
          method: 'POST',
          body: '',
          mailboxAddress: address
        },
        session
      );

    this.ensureUpstreamSuccess(response.data, response.status);

    const auth = response.data?.auth || response.data?.data?.auth;
    const refreshed = this.mergeSessionState(session, auth, response.headers, address);
    this.rememberMailboxSession(address, refreshed);
    return refreshed;
  }

  private async requestUpstream<T>(
    path: string,
    options: GptMailRequestOptions,
    session: GptMailSessionState
  ) {
    const url = `${GPTMAIL_BASE_URL}${path}`;
    const method = options.method || 'GET';
    const response = method === 'POST'
      ? await httpClient.post<T>(url, options.body ?? '', {
          headers: this.buildApiHeaders(session, options.mailboxAddress || session.email, {
            ...(options.headers || {})
          }),
          timeout: this.config.timeout,
          retries: this.config.retries
        })
      : await httpClient.get<T>(url, {
          headers: this.buildApiHeaders(session, options.mailboxAddress || session.email, {
            ...(options.headers || {})
          }),
          timeout: this.config.timeout,
          retries: this.config.retries
        });

    if (!response.ok) {
      const errorMessage = this.extractUpstreamErrorMessage(response.data) || `GPTMail API returned ${response.status}`;
      throw this.createError(
        response.status === 401 || response.status === 403
          ? ChannelErrorType.AUTHENTICATION_ERROR
          : ChannelErrorType.API_ERROR,
        errorMessage,
        response.status
      );
    }

    return response;
  }

  private buildBrowserHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      referer: `${GPTMAIL_BASE_URL}${GPTMAIL_HOME_PATH}`,
      'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'user-agent': GPTMAIL_BROWSER_USER_AGENT,
      ...extraHeaders
    };
  }

  private buildApiHeaders(
    session: GptMailSessionState,
    mailboxAddress = '',
    extraHeaders: Record<string, string> = {}
  ): Record<string, string> {
    const refererAddress = String(mailboxAddress || session?.email || '').trim();
    const referer = refererAddress
      ? `${GPTMAIL_BASE_URL}${GPTMAIL_HOME_PATH}${encodeURIComponent(refererAddress)}`
      : `${GPTMAIL_BASE_URL}${GPTMAIL_HOME_PATH}`;

    return {
      ...this.buildBrowserHeaders({
        referer
      }),
      'x-inbox-token': session.token,
      ...(session.gmSid ? { cookie: `gm_sid=${session.gmSid}` } : {}),
      ...extraHeaders
    };
  }

  private extractBrowserAuth(html: string): GptMailBrowserAuth {
    const match = String(html || '').match(/window\.__BROWSER_AUTH\s*=\s*(\{.*?\})\s*;/s);
    if (!match?.[1]) {
      throw this.createError(ChannelErrorType.AUTHENTICATION_ERROR, 'GPTMail browser auth bootstrap not found');
    }

    try {
      return JSON.parse(match[1]) as GptMailBrowserAuth;
    } catch (error) {
      throw this.createError(
        ChannelErrorType.AUTHENTICATION_ERROR,
        `Failed to parse GPTMail browser auth payload: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  private extractCookieValue(headers: Headers, cookieName: string): string {
    const typedHeaders = headers as Headers & {
      getSetCookie?: () => string[];
    };
    const rawValues = typeof typedHeaders.getSetCookie === 'function'
      ? typedHeaders.getSetCookie()
      : [headers.get('set-cookie') || ''];
    const escapedName = String(cookieName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escapedName}=([^;,]+)`);

    for (const rawValue of rawValues) {
      const match = String(rawValue || '').match(pattern);
      if (match?.[1]) {
        return String(match[1]).trim();
      }
    }

    return '';
  }

  private responseBodyToText(body: unknown): string {
    if (typeof body === 'string') {
      return body;
    }

    if (body instanceof ArrayBuffer) {
      return new TextDecoder('utf-8').decode(new Uint8Array(body));
    }

    if (ArrayBuffer.isView(body)) {
      return new TextDecoder('utf-8').decode(body);
    }

    return String(body || '');
  }

  private mergeSessionState(
    current: GptMailSessionState,
    auth: GptMailUpstreamAuth | undefined,
    headers: Headers,
    fallbackEmail: string
  ): GptMailSessionState {
    const gmSid = this.extractCookieValue(headers, 'gm_sid') || current.gmSid;
    const token = String(auth?.token || current.token || '').trim();
    const email = String(auth?.email || current.email || fallbackEmail || '').trim();
    const expiresAt = Number(auth?.expires_at || current.expiresAt || Math.floor(Date.now() / 1000) + 300);

    if (!token || !gmSid || !email) {
      throw this.createError(
        ChannelErrorType.AUTHENTICATION_ERROR,
        'GPTMail session state is incomplete after upstream request'
      );
    }

    return {
      token,
      gmSid,
      email,
      expiresAt
    };
  }

  private needsRefresh(session: GptMailSessionState): boolean {
    return Number(session.expiresAt || 0) <= Math.floor(Date.now() / 1000) + GPTMAIL_REFRESH_BUFFER_SECONDS;
  }

  private rememberMailboxSession(address: string, session: GptMailSessionState): void {
    if (!address) {
      return;
    }

    this.mailboxSessions.set(address, {
      ...session,
      email: address
    });
  }

  private serializeSessionState(session: GptMailSessionState): string {
    const json = JSON.stringify({
      token: session.token,
      gmSid: session.gmSid,
      email: session.email,
      expiresAt: session.expiresAt
    });

    return `${GPTMAIL_TOKEN_PREFIX}${this.base64UrlEncode(json)}`;
  }

  private deserializeSessionState(accessToken?: string): GptMailSessionState | null {
    const raw = String(accessToken || '').trim();
    if (!raw.startsWith(GPTMAIL_TOKEN_PREFIX)) {
      return null;
    }

    const encoded = raw.slice(GPTMAIL_TOKEN_PREFIX.length);
    if (!encoded) {
      return null;
    }

    try {
      const decoded = JSON.parse(this.base64UrlDecode(encoded)) as {
        token?: string;
        gmSid?: string;
        email?: string;
        expiresAt?: number;
      };

      if (!decoded?.token || !decoded?.gmSid) {
        return null;
      }

      return {
        token: String(decoded.token),
        gmSid: String(decoded.gmSid),
        email: String(decoded.email || '').trim(),
        expiresAt: Number(decoded.expiresAt || 0)
      };
    } catch (_error) {
      return null;
    }
  }

  private base64UrlEncode(value: string): string {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(value, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    }

    const bytes = new TextEncoder().encode(value);
    let binary = '';
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });

    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  private base64UrlDecode(value: string): string {
    const normalized = value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');

    if (typeof Buffer !== 'undefined') {
      return Buffer.from(normalized, 'base64').toString('utf8');
    }

    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  private ensureUpstreamSuccess(payload: { success?: boolean; error?: string; message?: string } | undefined, statusCode?: number): void {
    if (!payload) {
      return;
    }

    if (payload.success === false) {
      throw this.createError(
        statusCode === 401 || statusCode === 403
          ? ChannelErrorType.AUTHENTICATION_ERROR
          : ChannelErrorType.API_ERROR,
        payload.error || payload.message || 'GPTMail upstream returned an error',
        statusCode
      );
    }
  }

  private extractUpstreamErrorMessage(payload: unknown): string {
    if (!payload || typeof payload !== 'object') {
      return '';
    }

    const record = payload as Record<string, unknown>;
    return String(record.error || record.message || '').trim();
  }

  private mapInboxItemToEmail(item: GptMailInboxItem, fallbackAddress: string): EmailMessage {
    const id = String(item?.id ?? '').trim() || this.buildFallbackMessageId(item, fallbackAddress);
    const fromEmail = String(item?.from_address || item?.from || '').trim();
    const subject = String(item?.subject || '').trim();
    const htmlContent = String(item?.html || '').trim() || undefined;
    const textContent = String(item?.text || item?.content || '').trim();

    return {
      id,
      from: {
        email: fromEmail,
        name: String(item?.from_name || '').trim() || undefined
      },
      to: [{ email: fallbackAddress }],
      subject,
      textContent,
      htmlContent,
      receivedAt: parseDate(
        String(item?.timestamp || item?.date || item?.created_at || new Date().toISOString())
      ),
      isRead: false,
      provider: this.name
    };
  }

  private buildFallbackMessageId(item: GptMailInboxItem, address: string): string {
    const seed = [
      this.name,
      address,
      String(item?.from_address || item?.from || ''),
      String(item?.subject || ''),
      String(item?.timestamp || item?.date || item?.created_at || ''),
      String(item?.content || item?.text || '')
    ].join('|');

    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
      hash = ((hash << 5) - hash) + seed.charCodeAt(index);
      hash |= 0;
    }

    return `${this.name}-${Math.abs(hash)}`;
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
