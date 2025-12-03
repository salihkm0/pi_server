import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logInfo, logError, logSuccess, logWarning } from '../utils/logger.js';
import { getDeviceId, getSystemInfo, getRaspberryPiUsername } from '../utils/systemInfo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'device-config.json');

class ConfigManager {
  constructor() {
    this.config = null;
  }

  async loadConfig() {
    try {
      // Try to load existing config
      if (fs.existsSync(CONFIG_PATH)) {
        this.config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        logSuccess('✅ Loaded existing configuration');
        return this.config;
      }

      // Create new config
      await this.createDefaultConfig();
      return this.config;

    } catch (error) {
      logError('❌ Error loading config:', error);
      await this.createDefaultConfig();
      return this.config;
    }
  }

  async createDefaultConfig() {
    const deviceId = await getDeviceId();
    const username = await getRaspberryPiUsername();
    const systemInfo = await getSystemInfo();

    this.config = {
      deviceId: deviceId,
      username: username,
      version: "1.0.0",
      location: "unknown",
      platform: process.platform,
      autoUpdate: {
        enabled: true,
        checkInterval: 30,
        allowedTime: "02:00-06:00"
      },
      video: {
        autoPlay: true,
        shuffle: true,
        loop: true,
        defaultVolume: 80
      },
      sync: {
        enabled: true,
        interval: 10,
        onStartup: true
      },
      wifi: {
        controlledByServer: true,
        monitoringEnabled: true,
        checkInterval: 60, // Check every minute
        maxRetries: 5,
        platform: process.platform
      },
      system: systemInfo,
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    };

    await this.saveConfig();
    logSuccess('✅ Created default configuration');
    logSuccess('📡 WiFi is controlled by central server');

    return this.config;
  }

  async saveConfig() {
    try {
      const configDir = path.dirname(CONFIG_PATH);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      this.config.updated = new Date().toISOString();
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2));
      
      logSuccess('✅ Configuration saved');
    } catch (error) {
      logError('❌ Error saving config:', error);
    }
  }

  async updateConfig(updates) {
    this.config = { ...this.config, ...updates };
    await this.saveConfig();
  }

  get(key) {
    return key ? this.config[key] : this.config;
  }

  set(key, value) {
    this.config[key] = value;
    this.saveConfig();
  }

  // Validate configuration
  validateConfig() {
    const required = ['deviceId', 'version'];
    const missing = required.filter(field => !this.config[field]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required config fields: ${missing.join(', ')}`);
    }
    
    return true;
  }

  // Get WiFi configuration
  getWifiConfig() {
    return this.config.wifi || {};
  }

  // Check if WiFi is controlled by server
  isWifiControlledByServer() {
    return this.config.wifi?.controlledByServer !== false;
  }
}

export const configManager = new ConfigManager();