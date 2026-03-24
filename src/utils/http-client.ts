/**
 * HTTP 客户端工具类
 * 提供统一的 HTTP 请求功能，支持超时、重试、错误处理等
 */

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | FormData;
  cache?: RequestCache;
  redirect?: RequestRedirect;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

export interface HttpResponse<T = any> {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  data: T;
  url: string;
}

export class HttpClient {
  private readonly defaultTimeout = 10000;
  private readonly defaultRetries = 2;
  private readonly defaultRetryDelay = 1000;

  /**
   * 发送 HTTP 请求
   */
  async request<T = any>(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
    const {
      method = 'GET',
      headers = {},
      body,
      cache = 'no-store',
      redirect = 'follow',
      timeout = this.defaultTimeout,
      retries = this.defaultRetries,
      retryDelay = this.defaultRetryDelay
    } = options;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(url, {
          method,
          headers: {
            'User-Agent': 'TempMailHub/1.0.0',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            ...headers
          },
          body,
          cache,
          redirect,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        // 解析响应数据
        let data: T;
        const contentType = response.headers.get('content-type') || '';
        
        if (contentType.includes('application/json') || contentType.includes('+json')) {
          data = await response.json();
        } else if (contentType.includes('text/')) {
          data = await response.text() as T;
        } else {
          data = await response.arrayBuffer() as T;
        }

        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          data,
          url
        };

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // 如果是最后一次尝试，抛出错误
        if (attempt === retries) {
          break;
        }

        // 等待重试延迟
        if (attempt < retries) {
          await this.sleep(retryDelay * (attempt + 1));
        }
      }
    }

    throw lastError || new Error('Request failed');
  }

  /**
   * GET 请求
   */
  async get<T = any>(url: string, options: Omit<HttpRequestOptions, 'method' | 'body'> = {}): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'GET' });
  }

  /**
   * POST 请求
   */
  async post<T = any>(url: string, body?: any, options: Omit<HttpRequestOptions, 'method' | 'body'> = {}): Promise<HttpResponse<T>> {
    const headers = { ...options.headers };
    let requestBody: string | FormData | undefined;

    if (body) {
      if (body instanceof FormData) {
        requestBody = body;
      } else if (typeof body === 'object') {
        headers['Content-Type'] = 'application/json';
        requestBody = JSON.stringify(body);
      } else {
        requestBody = String(body);
      }
    }

    return this.request<T>(url, {
      ...options,
      method: 'POST',
      headers,
      body: requestBody
    });
  }

  /**
   * PUT 请求
   */
  async put<T = any>(url: string, body?: any, options: Omit<HttpRequestOptions, 'method' | 'body'> = {}): Promise<HttpResponse<T>> {
    const headers = { ...options.headers };
    let requestBody: string | undefined;

    if (body) {
      if (typeof body === 'object') {
        headers['Content-Type'] = 'application/json';
        requestBody = JSON.stringify(body);
      } else {
        requestBody = String(body);
      }
    }

    return this.request<T>(url, {
      ...options,
      method: 'PUT',
      headers,
      body: requestBody
    });
  }

  /**
   * DELETE 请求
   */
  async delete<T = any>(url: string, options: Omit<HttpRequestOptions, 'method' | 'body'> = {}): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'DELETE' });
  }

  /**
   * 睡眠函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 导出单例实例
export const httpClient = new HttpClient(); 
