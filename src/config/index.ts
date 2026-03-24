import type { Config, ChannelConfig } from '../types/index.js';

export const defaultConfig: Config = {
  channels: {
    tempmaillol: {
      enabled: true,
      priority: 1,
      timeout: 12000,
      retries: 1,
      rateLimit: {
        requests: 20,
        window: 60
      }
    },
    duckmail: {
      enabled: true,
      priority: 2,
      timeout: 10000,
      retries: 2,
      rateLimit: {
        requests: 30,
        window: 60
      }
    },
    tempmailing: {
      enabled: true,
      priority: 3,
      timeout: 10000,
      retries: 2,
      rateLimit: {
        requests: 30,
        window: 60
      }
    },
    minmail: {
      enabled: true,
      priority: 4,
      timeout: 10000,
      retries: 2,
      rateLimit: {
        requests: 30,
        window: 60
      }
    },
    mailtm: {
      enabled: true,
      priority: 5,
      timeout: 12000,
      retries: 2,
      rateLimit: {
        requests: 20,
        window: 60
      }
    },
    etempmail: {
      enabled: true,
      priority: 6,
      timeout: 15000,
      retries: 2,
      rateLimit: {
        requests: 25,
        window: 60
      }
    },
    yydsmail: {
      enabled: true,
      priority: 7,
      timeout: 12000,
      retries: 1,
      rateLimit: {
        requests: 20,
        window: 60
      }
    }
  },
  server: {
    port: 8080,
    host: '0.0.0.0',
    cors: {
      origin: ['*'],
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      headers: ['Content-Type', 'Authorization', 'X-Requested-With']
    }
  },
  security: {
    rateLimit: {
      enabled: true,
      requests: 100,
      window: 60
    }
  }
};

export class ConfigManager {
  private config: Config;
  private readonly configSources: Map<string, () => Partial<Config>> = new Map();

  constructor(initialConfig: Config = defaultConfig) {
    this.config = { ...initialConfig };
  }

  getConfig(): Config {
    return { ...this.config };
  }

  getChannelConfig(channelName: string) {
    return this.config.channels[channelName];
  }

  getEnabledChannels(): string[] {
    return Object.entries(this.config.channels)
      .filter(([, config]) => config.enabled)
      .sort(([, a], [, b]) => a.priority - b.priority)
      .map(([name]) => name);
  }

  updateChannelConfig(channelName: string, config: Partial<ChannelConfig[string]>) {
    if (this.config.channels[channelName]) {
      this.config.channels[channelName] = {
        ...this.config.channels[channelName],
        ...config
      };
    }
  }

  enableChannel(channelName: string) {
    this.updateChannelConfig(channelName, { enabled: true });
  }

  disableChannel(channelName: string) {
    this.updateChannelConfig(channelName, { enabled: false });
  }

  setChannelPriority(channelName: string, priority: number) {
    this.updateChannelConfig(channelName, { priority });
  }

  addConfigSource(name: string, source: () => Partial<Config>) {
    this.configSources.set(name, source);
  }

  async reloadConfig() {
    let newConfig = { ...defaultConfig };

    for (const [name, source] of this.configSources) {
      try {
        const sourceConfig = source();
        newConfig = this.mergeConfig(newConfig, sourceConfig);
      } catch (error) {
        console.warn(`Failed to load config from source ${name}:`, error);
      }
    }

    this.config = newConfig;
  }

  loadFromEnv() {
    const env = typeof globalThis !== 'undefined' &&
      (globalThis as any).process?.env ||
      (typeof globalThis !== 'undefined' && (globalThis as any).process ? (globalThis as any).process.env : {});

    const envConfig: Partial<Config> = {};

    if (env.PORT) {
      envConfig.server = {
        ...envConfig.server,
        port: parseInt(env.PORT, 10)
      };
    }

    if (env.HOST) {
      envConfig.server = {
        ...envConfig.server,
        host: env.HOST
      };
    }

    if (env.API_KEY) {
      envConfig.security = {
        ...envConfig.security,
        apiKey: env.API_KEY
      };
    }

    const channels: ChannelConfig = {};
    for (const channelName of Object.keys(defaultConfig.channels)) {
      const envKey = `CHANNEL_${channelName.toUpperCase()}_ENABLED`;
      if (env[envKey] !== undefined) {
        channels[channelName] = {
          ...defaultConfig.channels[channelName],
          enabled: env[envKey]?.toLowerCase() === 'true'
        };
      }
    }

    if (Object.keys(channels).length > 0) {
      envConfig.channels = channels;
    }

    this.config = this.mergeConfig(this.config, envConfig);
  }

  private mergeConfig(target: Config, source: Partial<Config>): Config {
    const result = { ...target };

    if (source.channels) {
      result.channels = { ...result.channels };
      for (const [name, config] of Object.entries(source.channels)) {
        result.channels[name] = {
          ...result.channels[name],
          ...config
        };
      }
    }

    if (source.server) {
      result.server = { ...result.server, ...source.server };
    }

    if (source.security) {
      result.security = { ...result.security, ...source.security };
    }

    return result;
  }

  validateConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const [name, config] of Object.entries(this.config.channels)) {
      if (config.priority < 1) {
        errors.push(`Channel ${name} priority must be >= 1`);
      }
      if (config.timeout !== undefined && config.timeout < 1000) {
        errors.push(`Channel ${name} timeout must be >= 1000ms`);
      }
      if (config.retries !== undefined && config.retries < 0) {
        errors.push(`Channel ${name} retries must be >= 0`);
      }
    }

    if (this.config.server.port && (this.config.server.port < 1 || this.config.server.port > 65535)) {
      errors.push('Server port must be between 1 and 65535');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

export const configManager = new ConfigManager();

configManager.loadFromEnv();
