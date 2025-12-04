import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logInfo, logError, logSuccess, logWarning } from "../utils/logger.js";
import { configManager } from "./configManager.js";
import { SERVER_URL, RPI_ID } from "../server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

// Default WiFi credentials
const DEFAULT_WIFI_SSID = "spotus";
const DEFAULT_WIFI_PASSWORD = "123456789";

// Local WiFi storage
const LOCAL_WIFI_PATH = path.join(__dirname, '..', 'config', '.local_wifi.json');
const ENCRYPTION_KEY_PATH = path.join(__dirname, '..', 'config', '.wifi_key');

class WifiManager {
  constructor() {
    this.isMonitoring = false;
    this.monitorInterval = null;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 3;
    this.currentWifiSsid = null;
    this.serverWifiConfigured = false;
    this.lastServerCheck = null;
    this.lastServerConfig = null;
    this.encryptionKey = this.getOrCreateEncryptionKey();
    this.isLinux = process.platform === 'linux';
    this.isMacOS = process.platform === 'darwin';
    
    // Load local WiFi config
    this.localWifiConfig = this.loadLocalWifiConfig();
  }

  // Get or create encryption key
  getOrCreateEncryptionKey() {
    try {
      if (fs.existsSync(ENCRYPTION_KEY_PATH)) {
        return fs.readFileSync(ENCRYPTION_KEY_PATH, 'utf8').trim();
      } else {
        const key = this.generateRandomKey(32);
        fs.writeFileSync(ENCRYPTION_KEY_PATH, key, { mode: 0o600 });
        return key;
      }
    } catch (error) {
      logError('Error handling encryption key:', error);
      return this.generateRandomKey(32);
    }
  }

  generateRandomKey(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  // Simple XOR encryption
  encrypt(text) {
    if (!text) return '';
    let result = '';
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i) ^ this.encryptionKey.charCodeAt(i % this.encryptionKey.length);
      result += String.fromCharCode(charCode);
    }
    return Buffer.from(result).toString('base64');
  }

  decrypt(encryptedText) {
    try {
      if (!encryptedText) return '';
      const decoded = Buffer.from(encryptedText, 'base64').toString();
      let result = '';
      for (let i = 0; i < decoded.length; i++) {
        const charCode = decoded.charCodeAt(i) ^ this.encryptionKey.charCodeAt(i % this.encryptionKey.length);
        result += String.fromCharCode(charCode);
      }
      return result;
    } catch (error) {
      logError('Decryption failed:', error);
      return '';
    }
  }

  // Load local WiFi configuration
  loadLocalWifiConfig() {
    try {
      if (fs.existsSync(LOCAL_WIFI_PATH)) {
        const data = JSON.parse(fs.readFileSync(LOCAL_WIFI_PATH, 'utf8'));
        
        // Decrypt password
        if (data.password_encrypted) {
          data.password = this.decrypt(data.password_encrypted);
        }
        
        logSuccess(`✅ Loaded local WiFi config: ${data.ssid}`);
        return data;
      }
    } catch (error) {
      logError('Error loading local WiFi config:', error);
    }
    
    // Return default config if file doesn't exist
    return this.createDefaultLocalWifi();
  }

  // Create default local WiFi config
  createDefaultLocalWifi() {
    const defaultConfig = {
      ssid: DEFAULT_WIFI_SSID,
      password: DEFAULT_WIFI_PASSWORD,
      source: 'default',
      priority: 3, // Lowest priority
      last_updated: new Date().toISOString(),
      is_default: true
    };
    
    this.saveLocalWifiConfig(defaultConfig);
    return defaultConfig;
  }

  // Save local WiFi configuration
  saveLocalWifiConfig(config) {
    try {
      const configToSave = {
        ssid: config.ssid,
        password_encrypted: this.encrypt(config.password),
        source: config.source || 'local',
        priority: config.priority || 1,
        last_updated: new Date().toISOString(),
        is_default: config.is_default || false,
        note: config.note || 'Auto-saved by system'
      };
      
      const configDir = path.dirname(LOCAL_WIFI_PATH);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      
      fs.writeFileSync(LOCAL_WIFI_PATH, JSON.stringify(configToSave, null, 2), {
        mode: 0o600
      });
      
      // Update in-memory config
      this.localWifiConfig = {
        ssid: config.ssid,
        password: config.password,
        source: config.source || 'local',
        priority: config.priority || 1,
        last_updated: configToSave.last_updated,
        is_default: config.is_default || false
      };
      
      logSuccess(`✅ Saved local WiFi config: ${config.ssid}`);
      return true;
    } catch (error) {
      logError('Error saving local WiFi config:', error);
      return false;
    }
  }

  // Get current WiFi config (combines all sources with priority)
  getCurrentWifiConfig() {
    const configs = [];
    
    // 1. Server config (highest priority - priority 1)
    if (this.lastServerConfig && this.lastServerConfig.hasConfig) {
      configs.push({
        ssid: this.lastServerConfig.ssid,
        password: this.lastServerConfig.password,
        source: 'server',
        priority: 1,
        hasConfig: true
      });
    }
    
    // 2. Local stored config (priority 2)
    if (this.localWifiConfig && this.localWifiConfig.ssid) {
      configs.push({
        ssid: this.localWifiConfig.ssid,
        password: this.localWifiConfig.password,
        source: this.localWifiConfig.source,
        priority: this.localWifiConfig.priority || 2,
        hasConfig: true
      });
    }
    
    // 3. Default config (lowest priority - priority 3)
    configs.push({
      ssid: DEFAULT_WIFI_SSID,
      password: DEFAULT_WIFI_PASSWORD,
      source: 'default',
      priority: 3,
      hasConfig: true
    });
    
    // Sort by priority (lower number = higher priority)
    configs.sort((a, b) => a.priority - b.priority);
    
    return configs[0]; // Return highest priority config
  }

  // ===== MISSING METHODS ADDED BELOW =====
  
  // Helper method for compatibility with old code
  getDefaultWifi() {
    return {
      ssid: DEFAULT_WIFI_SSID,
      password: DEFAULT_WIFI_PASSWORD,
      configured: true,
      source: 'default',
      hasPassword: true
    };
  }
  
  // Helper method for registration compatibility
  getWifiInfoForRegistration() {
    const config = this.getCurrentWifiConfig();
    return {
      ssid: config ? config.ssid : DEFAULT_WIFI_SSID,
      password: config ? config.password : DEFAULT_WIFI_PASSWORD,
      configured: true,
      source: config ? config.source : 'default',
      hasPassword: true
    };
  }
  
  // Disconnect from current WiFi
  async disconnectWifi() {
    try {
      const currentWifi = await this.getCurrentWifi();
      
      if (currentWifi.connected) {
        if (this.isLinux) {
          await execAsync(`nmcli connection down "${currentWifi.ssid}"`);
        } else if (this.isMacOS) {
          await execAsync('networksetup -setairportpower en0 off');
          await new Promise(resolve => setTimeout(resolve, 2000));
          await execAsync('networksetup -setairportpower en0 on');
        }
        
        logInfo(`Disconnected from WiFi: ${currentWifi.ssid}`);
        this.currentWifiSsid = null;
        
        return {
          success: true,
          message: `Disconnected from ${currentWifi.ssid}`,
          ssid: currentWifi.ssid
        };
      } else {
        return {
          success: true,
          message: 'Not connected to any WiFi'
        };
      }
    } catch (error) {
      logError('Error disconnecting WiFi:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  // Get current WiFi on macOS (missing implementation)
  async getCurrentWifiMacOS() {
    try {
      const { stdout } = await execAsync('/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I');
      const lines = stdout.split('\n');
      
      let ssid = null;
      for (const line of lines) {
        if (line.includes(' SSID:')) {
          ssid = line.split(':')[1].trim();
          break;
        }
      }
      
      if (ssid) {
        return {
          connected: true,
          ssid: ssid,
          signal: 100,
          ipAddress: await this.getIpAddress(),
          state: 'connected'
        };
      } else {
        return {
          connected: false,
          ssid: null,
          signal: 0,
          state: 'disconnected'
        };
      }
    } catch (error) {
      return {
        connected: false,
        ssid: null,
        signal: 0,
        error: error.message
      };
    }
  }
  
  // Get IP address
  async getIpAddress() {
    try {
      if (this.isLinux) {
        const { stdout } = await execAsync("hostname -I | awk '{print $1}'");
        return stdout.trim();
      } else if (this.isMacOS) {
        const { stdout } = await execAsync("ipconfig getifaddr en0");
        return stdout.trim();
      }
      return null;
    } catch (error) {
      return null;
    }
  }
  
  // Get WiFi signal strength
  async getWifiSignal(ssid) {
    try {
      if (this.isLinux) {
        const { stdout } = await execAsync(`nmcli -t -f ssid,signal dev wifi | grep "${ssid}:" | cut -d: -f2`);
        return parseInt(stdout.trim()) || 0;
      } else {
        return 80;
      }
    } catch (error) {
      return 0;
    }
  }
  // ===== END OF MISSING METHODS =====

  // Check if NetworkManager is available
  async checkNetworkManager() {
    try {
      await execAsync('which nmcli');
      return true;
    } catch (error) {
      logWarning('NetworkManager (nmcli) not available');
      return false;
    }
  }

// Fetch WiFi configuration from central server - READ ONLY, DON'T SAVE LOCALLY
async fetchWifiFromServer() {
  try {
    const axios = await import('axios');
    logInfo(`📡 Fetching WiFi configuration from central server for device: ${RPI_ID}`);
    
    const response = await axios.default.get(`${SERVER_URL}/api/wifi-config/${RPI_ID}`, {
      timeout: 10000,
      headers: {
        'User-Agent': `ADS-Display/${RPI_ID}`,
        'Accept': 'application/json'
      }
    });

    if (response.data.success && response.data.has_wifi_config) {
      const { wifi_ssid, wifi_password } = response.data;
      
      // Store server config for connection use ONLY
      this.lastServerConfig = {
        ssid: wifi_ssid,
        password: wifi_password,
        hasConfig: true,
        lastFetched: new Date()
      };
      
      logInfo(`📡 Server WiFi config: ${wifi_ssid} (READ ONLY - NOT saving locally)`);
      
      // IMPORTANT: DO NOT save server WiFi to local storage
      // WiFi should only be configured by server admin
      
      this.serverWifiConfigured = true;
      this.lastServerCheck = new Date();
      
      return {
        success: true,
        ssid: wifi_ssid,
        password: wifi_password,
        source: 'server',
        hasConfig: true
      };
    } else if (response.data.success && !response.data.has_wifi_config) {
      logInfo('📡 No WiFi configuration found on central server');
      
      this.lastServerConfig = {
        hasConfig: false,
        lastFetched: new Date()
      };
      
      this.serverWifiConfigured = false;
      this.lastServerCheck = new Date();
      
      return {
        success: true,
        hasConfig: false,
        source: 'server'
      };
    } else {
      throw new Error(`Server returned success=false`);
    }
  } catch (error) {
    logError('❌ Failed to fetch WiFi configuration from server:', error.message);
    
    this.lastServerConfig = {
      hasConfig: false,
      error: error.message,
      lastFetched: new Date()
    };
    
    this.serverWifiConfigured = false;
    this.lastServerCheck = new Date();
    
    return {
      success: false,
      error: error.message,
      source: 'server'
    };
  }
}

  // Connect to WiFi
  async connectToWifi(ssid, password, source = 'unknown') {
    try {
      logInfo(`🔗 Attempting to connect to WiFi: ${ssid} (Source: ${source})`);
      
      if (!ssid || !password) {
        throw new Error('SSID and password are required');
      }

      let result;
      
      if (this.isLinux) {
        result = await this.connectToWifiLinux(ssid, password);
      } else if (this.isMacOS) {
        result = await this.connectToWifiMacOS(ssid, password);
      } else {
        throw new Error(`Unsupported platform: ${process.platform}`);
      }

      if (result.success) {
        this.currentWifiSsid = ssid;
        this.connectionAttempts = 0;
        
        logSuccess(`✅ Connected to WiFi: ${ssid} (Source: ${source})`);
        
        return {
          success: true,
          ssid: ssid,
          source: source,
          message: `Connected to ${ssid} successfully`
        };
      } else {
        throw new Error(result.error);
      }

    } catch (error) {
      logError(`❌ Failed to connect to WiFi ${ssid}:`, error.message);
      this.connectionAttempts++;
      
      return {
        success: false,
        error: error.message,
        ssid: ssid,
        source: source,
        attempts: this.connectionAttempts
      };
    }
  }

  // Linux WiFi connection
  async connectToWifiLinux(ssid, password) {
    try {
      const nmAvailable = await this.checkNetworkManager();
      if (!nmAvailable) {
        throw new Error('NetworkManager (nmcli) is not available');
      }

      // Delete existing connection if it exists
      try {
        await execAsync(`nmcli connection delete "${ssid}" 2>/dev/null || true`);
      } catch (error) {
        // Ignore errors
      }

      // Connect to WiFi
      const { stdout, stderr } = await execAsync(
        `nmcli device wifi connect "${ssid}" password "${password}"`,
        { timeout: 20000 }
      );

      if (stderr && !stdout.includes('successfully activated')) {
        throw new Error(stderr);
      }

      // Wait for connection to stabilize
      await new Promise(resolve => setTimeout(resolve, 3000));

      return { success: true, ssid };

    } catch (error) {
      throw new Error(`Linux connection failed: ${error.message}`);
    }
  }

  // macOS WiFi connection
  async connectToWifiMacOS(ssid, password) {
    try {
      logInfo(`🔗 Connecting to WiFi on macOS: ${ssid}`);
      
      const commands = [
        `networksetup -setairportnetwork en0 "${ssid}" "${password}"`,
        `networksetup -setairportnetwork en1 "${ssid}" "${password}"`
      ];
      
      for (const cmd of commands) {
        try {
          await execAsync(cmd, { timeout: 20000 });
          
          // Wait for connection
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // Verify connection
          const currentWifi = await this.getCurrentWifiMacOS();
          if (currentWifi.ssid === ssid) {
            return { success: true, ssid };
          }
        } catch (error) {
          continue;
        }
      }
      
      throw new Error('Failed to connect using networksetup');
      
    } catch (error) {
      throw new Error(`macOS connection failed: ${error.message}`);
    }
  }

  // Get current WiFi connection
  async getCurrentWifi() {
    try {
      if (this.isLinux) {
        return await this.getCurrentWifiLinux();
      } else if (this.isMacOS) {
        return await this.getCurrentWifiMacOS();
      } else {
        return {
          connected: false,
          ssid: null,
          error: `Unsupported platform: ${process.platform}`
        };
      }
    } catch (error) {
      logError('Error getting current WiFi:', error);
      return {
        connected: false,
        ssid: null,
        error: error.message
      };
    }
  }

  // Get current WiFi on Linux
  async getCurrentWifiLinux() {
    try {
      const { stdout } = await execAsync('nmcli -t -f active,ssid dev wifi | grep yes: | cut -d: -f2');
      const ssid = stdout.trim();
      
      if (ssid) {
        const signal = await this.getWifiSignal(ssid);
        
        return {
          connected: true,
          ssid: ssid,
          signal: signal,
          ipAddress: await this.getIpAddress(),
          state: 'connected'
        };
      } else {
        return {
          connected: false,
          ssid: null,
          signal: 0,
          state: 'disconnected'
        };
      }
    } catch (error) {
      return {
        connected: false,
        ssid: null,
        signal: 0,
        error: error.message
      };
    }
  }

  // Test internet connectivity
  async testInternet() {
    const testEndpoints = [
      'https://www.google.com',
      'https://www.cloudflare.com'
    ];

    for (const endpoint of testEndpoints) {
      try {
        const { default: axios } = await import('axios');
        await axios.get(endpoint, { timeout: 5000 });
        return true;
      } catch (error) {
        continue;
      }
    }
    
    return false;
  }

  // Main WiFi control logic
  async controlWifi() {
    try {
      logInfo('🔄 Starting WiFi control cycle...');
      
      // Step 1: Get current status
      const currentWifi = await this.getCurrentWifi();
      const hasInternet = await this.testInternet();
      
      logInfo(`📊 Current: WiFi=${currentWifi.ssid || 'None'}, Internet=${hasInternet}`);
      
      // Step 2: Try to fetch from server (if internet is available)
      let serverConfig = null;
      if (hasInternet) {
        serverConfig = await this.fetchWifiFromServer();
      } else {
        logInfo('🌐 No internet - using local WiFi config');
      }
      
      // Step 3: Get the best WiFi config to use
      const wifiConfig = this.getCurrentWifiConfig();
      logInfo(`📡 Using WiFi config: ${wifiConfig.ssid} (Source: ${wifiConfig.source})`);
      
      // Step 4: Check if we need to connect/reconnect
      if (currentWifi.ssid === wifiConfig.ssid) {
        // Already connected to target WiFi
        if (hasInternet) {
          logInfo(`✅ Connected to ${wifiConfig.ssid} with internet`);
        } else {
          logWarning(`⚠️ Connected to ${wifiConfig.ssid} but no internet`);
          // Try reconnecting
          await this.disconnectWifi();
          await new Promise(resolve => setTimeout(resolve, 3000));
          await this.connectToWifi(wifiConfig.ssid, wifiConfig.password, `${wifiConfig.source}-retry`);
        }
      } else {
        // Not connected or connected to different WiFi
        logInfo(`🔄 Switching to WiFi: ${wifiConfig.ssid} (${wifiConfig.source})`);
        
        if (currentWifi.connected) {
          await this.disconnectWifi();
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        const connectResult = await this.connectToWifi(
          wifiConfig.ssid, 
          wifiConfig.password, 
          wifiConfig.source
        );
        
        if (connectResult.success) {
          logSuccess(`✅ Connected to ${wifiConfig.ssid}`);
        } else {
          logError(`❌ Failed to connect to ${wifiConfig.ssid}: ${connectResult.error}`);
          
          // Try next priority config
          await this.tryFallbackConnection();
        }
      }
      
      // Reset connection attempts if successful
      const finalWifi = await this.getCurrentWifi();
      const finalInternet = await this.testInternet();
      
      if (finalWifi.connected && finalInternet) {
        this.connectionAttempts = 0;
      }
      
      // Log summary
      logInfo(`📊 WiFi Cycle Complete: Connected=${finalWifi.connected}, Internet=${finalInternet}`);
      
    } catch (error) {
      logError('❌ WiFi control error:', error);
      this.connectionAttempts++;
      
      // Try fallback on error
      if (this.connectionAttempts >= this.maxConnectionAttempts) {
        logWarning(`🔄 Max attempts reached, trying fallback...`);
        await this.tryFallbackConnection();
      }
    }
  }

  // Try fallback connection
  async tryFallbackConnection() {
    try {
      logInfo('🔄 Trying fallback WiFi connection...');
      
      // Get all available configs
      const configs = [
        // Server config
        ...(this.lastServerConfig && this.lastServerConfig.hasConfig ? [{
          ssid: this.lastServerConfig.ssid,
          password: this.lastServerConfig.password,
          source: 'server-fallback',
          priority: 1
        }] : []),
        
        // Local config
        ...(this.localWifiConfig && this.localWifiConfig.ssid ? [{
          ssid: this.localWifiConfig.ssid,
          password: this.localWifiConfig.password,
          source: this.localWifiConfig.source,
          priority: this.localWifiConfig.priority || 2
        }] : []),
        
        // Default config
        {
          ssid: DEFAULT_WIFI_SSID,
          password: DEFAULT_WIFI_PASSWORD,
          source: 'default-fallback',
          priority: 3
        }
      ];
      
      // Sort by priority
      configs.sort((a, b) => a.priority - b.priority);
      
      // Try each config
      for (const config of configs) {
        try {
          logInfo(`🔄 Trying fallback: ${config.ssid}`);
          const result = await this.connectToWifi(config.ssid, config.password, config.source);
          if (result.success) {
            logSuccess(`✅ Fallback successful: ${config.ssid}`);
            return true;
          }
        } catch (error) {
          continue;
        }
      }
      
      logError('❌ All fallback attempts failed');
      return false;
      
    } catch (error) {
      logError('Fallback connection error:', error);
      return false;
    }
  }

  // Start WiFi monitoring
  startMonitoring() {
    if (this.isMonitoring) {
      logWarning('WiFi monitoring is already running');
      return;
    }

    this.isMonitoring = true;
    logInfo('🚀 Starting WiFi monitoring service');

    // Initial control after 5 seconds
    setTimeout(() => {
      this.controlWifi();
    }, 5000);

    // Monitor every 30 seconds
    this.monitorInterval = setInterval(() => {
      this.controlWifi();
    }, 30000);

    logSuccess('✅ WiFi monitoring started (checks every 30 seconds)');
  }

  // Stop WiFi monitoring
  stopMonitoring() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.isMonitoring = false;
    this.connectionAttempts = 0;
    logInfo('🛑 WiFi monitoring stopped');
  }

  // Manual connection and save
  async manualConnectAndSave(ssid, password, source = 'manual') {
    try {
      logInfo(`🔧 Manual WiFi setup: ${ssid}`);
      
      // Save to local storage
      this.saveLocalWifiConfig({
        ssid: ssid,
        password: password,
        source: source,
        priority: 1,
        note: 'Manually configured'
      });
      
      // Connect
      const result = await this.connectToWifi(ssid, password, source);
      
      return result;
    } catch (error) {
      logError('Manual connection error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Get WiFi info for API
  getWifiInfo() {
    return {
      current: this.currentWifiSsid,
      local_config: {
        ssid: this.localWifiConfig.ssid,
        source: this.localWifiConfig.source,
        last_updated: this.localWifiConfig.last_updated,
        is_default: this.localWifiConfig.is_default
      },
      server_config: this.lastServerConfig,
      default_config: {
        ssid: DEFAULT_WIFI_SSID,
        source: 'default'
      },
      monitoring: this.isMonitoring
    };
  }

  // API: Get current WiFi status
  async getWifiStatus() {
    const currentWifi = await this.getCurrentWifi();
    const hasInternet = await this.testInternet();
    
    return {
      current_wifi: currentWifi,
      internet: hasInternet,
      local_config: {
        ssid: this.localWifiConfig.ssid,
        source: this.localWifiConfig.source
      },
      server_config: this.lastServerConfig,
      monitoring: this.getMonitoringStatus()
    };
  }

  // Get monitoring status
  getMonitoringStatus() {
    return {
      isMonitoring: this.isMonitoring,
      connectionAttempts: this.connectionAttempts,
      maxConnectionAttempts: this.maxConnectionAttempts,
      currentWifiSsid: this.currentWifiSsid,
      serverWifiConfigured: this.serverWifiConfigured,
      lastServerCheck: this.lastServerCheck,
      hasLocalConfig: !!(this.localWifiConfig && this.localWifiConfig.ssid),
      checkInterval: '30 seconds',
      nextCheckIn: this.monitorInterval ? '30 seconds' : 'Not monitoring'
    };
  }
  
  // Scan networks (optional)
  async scanNetworks() {
    try {
      logInfo('Scanning for available networks...');
      
      if (this.isLinux) {
        return await this.scanNetworksLinux();
      } else if (this.isMacOS) {
        return await this.scanNetworksMacOS();
      } else {
        logWarning(`Network scanning not supported on: ${process.platform}`);
        return [];
      }
    } catch (error) {
      logError('Error scanning networks:', error);
      return [];
    }
  }

  async scanNetworksLinux() {
    try {
      await execAsync('nmcli dev wifi rescan');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const { stdout } = await execAsync('nmcli -t -f ssid,signal,security dev wifi');
      const networks = stdout.trim().split('\n')
        .filter(line => line && !line.startsWith('--:'))
        .map(line => {
          const [ssid, signal, security] = line.split(':');
          return {
            ssid: ssid || 'Unknown',
            signal: parseInt(signal) || 0,
            security: security || 'none',
            quality: this.getSignalQuality(parseInt(signal) || 0)
          };
        })
        .filter(network => network.ssid && network.ssid !== '' && network.ssid !== 'Unknown')
        .sort((a, b) => b.signal - a.signal);
      
      logInfo(`Found ${networks.length} networks`);
      return networks;
    } catch (error) {
      logError('Linux network scan failed:', error);
      return [];
    }
  }

  getSignalQuality(signal) {
    if (signal >= 80) return 'Excellent';
    if (signal >= 60) return 'Good';
    if (signal >= 40) return 'Fair';
    if (signal >= 20) return 'Weak';
    return 'Very Weak';
  }
}

export const wifiManager = new WifiManager();