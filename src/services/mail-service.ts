import type {
  EmailAddress,
  EmailMessage,
  CreateEmailRequest,
  CreateEmailResponse,
  EmailListQuery
} from '../types/email.js';
import type { ApiResponse } from '../types/index.js';
import { providerManager } from '../providers/index.js';
import { generateId } from '../utils/helpers.js';

/**
 * 邮件服务主类
 * 提供统一的邮件操作接口
 */
export class MailService {
  /**
   * 创建临时邮箱
   */
  async createEmail(request: CreateEmailRequest = {}): Promise<ApiResponse<CreateEmailResponse>> {
    try {
      // 根据请求选择合适的提供者
      const capabilities = {
        createEmail: true,
        customDomains: !!request.domain,
        customPrefix: !!request.prefix,
        emailExpiration: !!request.expirationMinutes
      };

      const provider = request.provider ? 
        providerManager.getProvider(request.provider) :
        providerManager.getBestProvider(capabilities);

      if (!provider) {
        return {
          success: false,
          error: 'No available email provider found',
          timestamp: new Date().toISOString()
        };
      }

      const response = await provider.createEmail(request);

      if (response.success && response.data) {
        return {
          success: true,
          data: response.data,
          timestamp: new Date().toISOString(),
          provider: provider.name
        };
      } else {
        return {
          success: false,
          error: response.error?.message || 'Failed to create email',
          timestamp: new Date().toISOString(),
          provider: provider.name
        };
      }

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 获取邮件列表
   */
  async getEmails(query: EmailListQuery): Promise<ApiResponse<EmailMessage[]>> {
    try {
      // 从邮箱地址推断提供者
      const provider = query.provider ? 
        providerManager.getProvider(query.provider) :
        this.inferProvider(query.address, query.accessToken);

      if (!provider) {
        return {
          success: false,
          error: 'No provider found for the email address',
          timestamp: new Date().toISOString()
        };
      }

      const response = await provider.getEmails(query);

      if (response.success && response.data) {
        return {
          success: true,
          data: response.data,
          timestamp: new Date().toISOString(),
          provider: provider.name
        };
      } else {
        return {
          success: false,
          error: response.error?.message || 'Failed to get emails',
          timestamp: new Date().toISOString(),
          provider: provider.name
        };
      }

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 获取邮件详情
   */
  async getEmailContent(emailAddress: string, emailId: string, providerName?: string, accessToken?: string): Promise<ApiResponse<EmailMessage>> {
    try {
      const provider = providerName ? 
        providerManager.getProvider(providerName) :
        this.inferProvider(emailAddress, accessToken);

      if (!provider) {
        return {
          success: false,
          error: 'No provider found for the email address',
          timestamp: new Date().toISOString()
        };
      }

      const response = await provider.getEmailContent(emailAddress, emailId, accessToken);

      if (response.success && response.data) {
        return {
          success: true,
          data: response.data,
          timestamp: new Date().toISOString(),
          provider: provider.name
        };
      } else {
        return {
          success: false,
          error: response.error?.message || 'Failed to get email content',
          timestamp: new Date().toISOString(),
          provider: provider.name
        };
      }

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      };
    }
  }



  /**
   * 获取所有提供者的健康状态
   */
  async getProvidersHealth(): Promise<ApiResponse<Record<string, any>>> {
    try {
      const health = await providerManager.getAllHealth();
      
      return {
        success: true,
        data: health,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 获取所有提供者的统计信息
   */
  getProvidersStats(): ApiResponse<Record<string, any>> {
    try {
      const stats = providerManager.getAllStats();
      
      return {
        success: true,
        data: stats,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 从邮箱地址推断提供者
   */
  private inferProvider(emailAddress: string, accessToken?: string): any {
    const token = String(accessToken || '').trim();
    if (token.startsWith('gptmail.')) {
      return providerManager.getProvider('gptmail');
    }

    const domain = emailAddress.split('@')[1];
    
    // 根据域名推断提供者
    const domainMapping: Record<string, string> = {
      'duckmail.sbs': 'duckmail',
      'atminmail.com': 'minmail',
      'somoj.com': 'mailtm',
      'sharebot.net': 'mailtm',
      'ohm.edu.pl': 'etempmail',
      'cross.edu.pl': 'etempmail',
      'usa.edu.pl': 'etempmail',
      'beta.edu.pl': 'etempmail',
      'theeditai.com': 'tempmailing'
    };

    const providerName = domainMapping[domain]
      || (domain.endsWith('.cloudvxz.com') ? 'tempmaillol' : '')
      || (domain.endsWith('.leadharbor.org') ? 'tempmaillol' : '');
    return providerName ? providerManager.getProvider(providerName) : null;
  }
}

// 导出单例实例
export const mailService = new MailService(); 
