/**
 * 辅助工具函数
 */

/**
 * 生成随机字符串
 */
export function generateRandomString(length: number = 8, charset: string = 'abcdefghijklmnopqrstuvwxyz0123456789'): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return result;
}

/**
 * 生成随机邮箱前缀
 */
export function generateEmailPrefix(length: number = 8): string {
  return generateRandomString(length, 'abcdefghijklmnopqrstuvwxyz0123456789');
}

/**
 * 生成唯一 ID
 */
export function generateId(): string {
  return `${Date.now()}-${generateRandomString(6)}`;
}

/**
 * 验证邮箱地址格式
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * 提取邮箱的用户名和域名
 */
export function parseEmail(email: string): { username: string; domain: string } | null {
  if (!isValidEmail(email)) {
    return null;
  }
  
  const [username, domain] = email.split('@');
  return { username, domain };
}

/**
 * 格式化时间戳
 */
export function formatTimestamp(date: Date | string | number): string {
  const d = parseDate(date);
  return d.toISOString();
}

/**
 * 解析时间字符串
 */
export function parseDate(dateInput: Date | string | number): Date {
  if (dateInput instanceof Date) {
    return isNaN(dateInput.getTime()) ? new Date() : dateInput;
  }

  if (typeof dateInput === 'number' && Number.isFinite(dateInput)) {
    const timestamp = Math.abs(dateInput) < 1e12 ? dateInput * 1000 : dateInput;
    const numericDate = new Date(timestamp);
    return isNaN(numericDate.getTime()) ? new Date() : numericDate;
  }

  const dateString = String(dateInput || '').trim();
  if (!dateString) {
    return new Date();
  }

  if (/^-?\d+(?:\.\d+)?$/.test(dateString)) {
    const numeric = Number(dateString);
    if (Number.isFinite(numeric)) {
      const timestamp = Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
      const numericDate = new Date(timestamp);
      if (!isNaN(numericDate.getTime())) {
        return numericDate;
      }
    }
  }
  // 尝试多种日期格式
  let date = new Date(dateString);
  
  if (isNaN(date.getTime())) {
    // 尝试其他格式
    const formats = [
      /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/, // YYYY/MM/DD HH:mm:ss
      /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/, // DD/MM/YYYY HH:mm:ss
    ];
    
    for (const format of formats) {
      const match = dateString.match(format);
      if (match) {
        if (format === formats[0]) {
          // YYYY/MM/DD HH:mm:ss
          date = new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]), 
                         parseInt(match[4]), parseInt(match[5]), parseInt(match[6]));
        } else if (format === formats[1]) {
          // DD/MM/YYYY HH:mm:ss
          date = new Date(parseInt(match[3]), parseInt(match[2]) - 1, parseInt(match[1]), 
                         parseInt(match[4]), parseInt(match[5]), parseInt(match[6]));
        }
        break;
      }
    }
  }
  
  return isNaN(date.getTime()) ? new Date() : date;
}

/**
 * 延迟执行
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 重试执行函数
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    retries: number;
    delay?: number;
    backoff?: boolean;
  }
): Promise<T> {
  const { retries, delay: baseDelay = 1000, backoff = true } = options;
  
  let lastError: Error;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt === retries) {
        throw lastError;
      }
      
      const delayMs = backoff ? baseDelay * Math.pow(2, attempt) : baseDelay;
      await delay(delayMs);
    }
  }
  
  throw lastError!;
}

/**
 * 安全的 JSON 解析
 */
export function safeJsonParse<T = any>(jsonString: string, defaultValue?: T): T | null {
  try {
    return JSON.parse(jsonString);
  } catch {
    return defaultValue ?? null;
  }
}

/**
 * 清理 HTML 标签
 */
export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * 截取文本
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * 获取预览文本
 */
export function getEmailPreview(content: string, maxLength: number = 100): string {
  const cleanText = stripHtml(content);
  return truncateText(cleanText, maxLength);
}

/**
 * 计算字符串哈希值
 */
export function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // 转换为32位整数
  }
  return hash;
}

/**
 * 检查是否为有效的 URL
 */
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * 合并对象（深度合并）
 */
export function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  
  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];
    
    if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue) &&
        targetValue && typeof targetValue === 'object' && !Array.isArray(targetValue)) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else {
      result[key] = sourceValue as T[typeof key];
    }
  }
  
  return result;
}

/**
 * 检查对象是否为空
 */
export function isEmpty(obj: any): boolean {
  if (obj == null) return true;
  if (Array.isArray(obj) || typeof obj === 'string') return obj.length === 0;
  if (typeof obj === 'object') return Object.keys(obj).length === 0;
  return false;
} 
