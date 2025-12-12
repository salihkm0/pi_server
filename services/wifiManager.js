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
    
    // Load local WiFi config (only from server)
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
        
        // Check if it's a server config
        if (data.source === 'server') {
          // Decrypt password
          if (data.password_encrypted) {
            data.password = this.decrypt(data.password_encrypted);
          }
          
          logSuccess(`✅ Loaded server WiFi config from file: ${data.ssid}`);
          return {
            ssid: data.ssid,
            password: data.password,
            source: data.source,
            priority: data.priority || 1,
            last_updated: data.last_updated,
            is_default: data.is_default || false
          };
        } else {
          logWarning(`⚠️ Found non-server WiFi config (${data.source}), ignoring it`);
          return this.createEmptyLocalConfig();
        }
      }
    } catch (error) {
      logError('Error loading local WiFi config:', error);
    }
    
    // Return empty config if no server config exists
    return this.createEmptyLocalConfig();
  }

  // Create empty local config
  createEmptyLocalConfig() {
    return {
      ssid: null,
      password: null,
      source: 'none',
      priority: 0,
      last_updated: null,
      is_default: false
    };
  }

  // Save WiFi configuration to file (only server configs)
  saveWifiConfigToFile(ssid, password, source = 'server') {
    try {
      // Only allow server configs
      if (source !== 'server') {
        logError(`❌ Rejected WiFi config from ${source} - only server configs allowed`);
        return false;
      }

      const configToSave = {
        ssid: ssid,
        password_encrypted: this.encrypt(password),
        source: source,
        priority: 1,
        last_updated: new Date().toISOString(),
        is_default: false,
        note: 'Synced from central server'
      };
      
      // Ensure config directory exists
      const configDir = path.dirname(LOCAL_WIFI_PATH);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      
      // Save to file
      fs.writeFileSync(LOCAL_WIFI_PATH, JSON.stringify(configToSave, null, 2), {
        mode: 0o600
      });
      
      // Update in-memory config
      this.localWifiConfig = {
        ssid: ssid,
        password: password,
        source: source,
        priority: 1,
        last_updated: configToSave.last_updated,
        is_default: false
      };
      
      logSuccess(`✅ Saved server WiFi config to ${LOCAL_WIFI_PATH}: ${ssid}`);
      
      // Debug: Log what was saved
      logInfo(`📝 Saved config: ${JSON.stringify({
        ssid: ssid,
        source: source,
        last_updated: configToSave.last_updated
      })}`);
      
      return true;
    } catch (error) {
      logError('❌ Error saving WiFi config to file:', error);
      return false;
    }
  }

  // Clear all WiFi connections except server-configured one
  async clearAllWiFiConnections() {
    try {
      logInfo('🧹 Clearing all WiFi connections...');
      
      if (this.isLinux) {
        // Get all WiFi connections
        const { stdout } = await execAsync('nmcli -t -f name,type connection show | grep wifi');
        const connections = stdout.trim().split('\n').filter(line => line);
        
        for (const line of connections) {
          const [connectionName] = line.split(':');
          
          // Skip if it's our server-configured WiFi
          if (this.localWifiConfig.ssid && connectionName === this.localWifiConfig.ssid) {
            logInfo(`Keeping server WiFi: ${connectionName}`);
            continue;
          }
          
          // Delete the connection
          try {
            await execAsync(`nmcli connection delete "${connectionName}"`);
            logInfo(`Deleted WiFi connection: ${connectionName}`);
          } catch (error) {
            // Connection might not exist, continue
          }
        }
      }
      
      logSuccess('✅ Cleared all non-server WiFi connections');
      return true;
    } catch (error) {
      logError('Error clearing WiFi connections:', error);
      return false;
    }
  }

  // Fetch WiFi from server, save to file, then apply it
  async fetchAndApplyServerWifi() {
    try {
      logInfo('🔄 Fetching and applying server WiFi configuration...');
      
      // Step 1: Fetch from server
      const serverConfig = await this.fetchWifiFromServer();
      
      if (!serverConfig.success || !serverConfig.hasConfig) {
        logWarning('📡 No server WiFi configuration available');
        
        // Clear any existing connections if no server config
        await this.clearAllWiFiConnections();
        
        return {
          success: false,
          error: 'No WiFi configuration found on server',
          hasConfig: false
        };
      }
      
      logInfo(`📡 Server WiFi config received: ${serverConfig.ssid}`);
      
      // Step 2: Save server config to file FIRST
      const saved = this.saveWifiConfigToFile(
        serverConfig.ssid,
        serverConfig.password,
        'server'
      );
      
      if (!saved) {
        logError('❌ Failed to save server WiFi config to file');
        return {
          success: false,
          error: 'Failed to save WiFi configuration',
          hasConfig: true
        };
      }
      
      logSuccess(`✅ Server WiFi config saved to file: ${serverConfig.ssid}`);
      
      // Step 3: Clear all existing connections
      await this.clearAllWiFiConnections();
      
      // Step 4: Connect using the saved config
      logInfo(`🔗 Attempting to connect using saved config: ${serverConfig.ssid}`);
      const connectResult = await this.connectUsingSavedConfig();
      
      if (connectResult.success) {
        logSuccess(`✅ Connected to server WiFi: ${serverConfig.ssid}`);
        return {
          success: true,
          ssid: serverConfig.ssid,
          source: 'server'
        };
      } else {
        logError(`❌ Failed to connect to server WiFi: ${connectResult.error}`);
        
        // Try one more time with direct connection
        logInfo(`🔄 Retrying direct connection: ${serverConfig.ssid}`);
        const retryResult = await this.connectToWifiDirect(
          serverConfig.ssid,
          serverConfig.password,
          'server-retry'
        );
        
        if (retryResult.success) {
          logSuccess(`✅ Connected on retry: ${serverConfig.ssid}`);
          return retryResult;
        }
        
        // Stay disconnected if can't connect to server WiFi
        await this.disconnectWifi();
        return {
          success: false,
          error: connectResult.error,
          hasConfig: true
        };
      }
    } catch (error) {
      logError('❌ Error applying server WiFi:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Connect using saved config from file
  async connectUsingSavedConfig() {
    try {
      // Reload config from file to ensure we have latest
      const config = this.loadLocalWifiConfig();
      
      if (!config.ssid || !config.password) {
        throw new Error('No WiFi configuration found in local file');
      }
      
      logInfo(`🔗 Connecting using saved config: ${config.ssid}`);
      
      return await this.connectToWifiDirect(
        config.ssid,
        config.password,
        'server-from-file'
      );
    } catch (error) {
      logError('Error connecting using saved config:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Direct WiFi connection method
  async connectToWifiDirect(ssid, password, source = 'server') {
    try {
      logInfo(`🔗 Direct connection to: ${ssid} (Source: ${source})`);
      
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
        
        logSuccess(`✅ Connected to ${ssid}`);
        
        return {
          success: true,
          ssid: ssid,
          source: source,
          message: `Connected to ${ssid}`
        };
      } else {
        throw new Error(result.error);
      }

    } catch (error) {
      logError(`❌ Failed to connect to ${ssid}:`, error.message);
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

  // Fetch WiFi configuration from central server
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
        
        logInfo(`✅ Server WiFi config found: ${wifi_ssid}`);
        
        // Store server config
        this.lastServerConfig = {
          ssid: wifi_ssid,
          password: wifi_password,
          hasConfig: true,
          lastFetched: new Date()
        };
        
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
        logInfo(`Deleted existing connection: ${ssid}`);
      } catch (error) {
        // Ignore errors
      }

      // Connect to WiFi
      logInfo(`🔗 Executing: nmcli device wifi connect "${ssid}" password "********"`);
      const { stdout, stderr } = await execAsync(
        `nmcli device wifi connect "${ssid}" password "${password}"`,
        { timeout: 30000 }
      );

      logInfo(`📋 Connection output: ${stdout}`);
      
      if (stderr && !stdout.includes('successfully activated')) {
        logError(`❌ Connection stderr: ${stderr}`);
        throw new Error(stderr);
      }

      // Wait for connection to stabilize
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Verify connection
      const currentWifi = await this.getCurrentWifiLinux();
      if (currentWifi.ssid === ssid) {
        return { success: true, ssid };
      } else {
        throw new Error('Connection verification failed');
      }

    } catch (error) {
      throw new Error(`Linux connection failed: ${error.message}`);
    }
  }

  // macOS WiFi connection
  async connectToWifiMacOS(ssid, password) {
    try {
      logInfo(`🔗 Connecting to WiFi on macOS: ${ssid}`);
      
      // Try different network interfaces
      const commands = [
        `networksetup -setairportnetwork en0 "${ssid}" "${password}"`,
        `networksetup -setairportnetwork en1 "${ssid}" "${password}"`
      ];
      
      for (const cmd of commands) {
        try {
          logInfo(`🔗 Executing: ${cmd.replace(password, '********')}`);
          await execAsync(cmd, { timeout: 30000 });
          
          // Wait for connection
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // Verify connection
          const currentWifi = await this.getCurrentWifiMacOS();
          if (currentWifi.ssid === ssid) {
            logSuccess(`✅ Connected on macOS: ${ssid}`);
            return { success: true, ssid };
          }
        } catch (error) {
          logWarning(`⚠️ Failed with command: ${error.message}`);
          continue;
        }
      }
      
      throw new Error('Failed to connect using networksetup');
      
    } catch (error) {
      throw new Error(`macOS connection failed: ${error.message}`);
    }
  }

  // Get server WiFi config
  getServerWifiConfig() {
    return this.lastServerConfig;
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
          state: 'connected',
          source: ssid === this.localWifiConfig.ssid ? 'server' : 'unauthorized'
        };
      } else {
        return {
          connected: false,
          ssid: null,
          signal: 0,
          state: 'disconnected',
          source: 'none'
        };
      }
    } catch (error) {
      return {
        connected: false,
        ssid: null,
        signal: 0,
        error: error.message,
        source: 'none'
      };
    }
  }

  // Get current WiFi on macOS
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
          state: 'connected',
          source: ssid === this.localWifiConfig.ssid ? 'server' : 'unauthorized'
        };
      } else {
        return {
          connected: false,
          ssid: null,
          signal: 0,
          state: 'disconnected',
          source: 'none'
        };
      }
    } catch (error) {
      return {
        connected: false,
        ssid: null,
        signal: 0,
        error: error.message,
        source: 'none'
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

  // Disconnect from WiFi
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

  // Main WiFi control logic - Only connects to server WiFi
  async controlWifi() {
    try {
      logInfo('🔄 Starting server-only WiFi control...');
      
      // Get current status
      const currentWifi = await this.getCurrentWifi();
      const hasInternet = await this.testInternet();
      
      logInfo(`📊 Current: WiFi=${currentWifi.ssid || 'None'}, Internet=${hasInternet}`);
      
      // Fetch server config
      const serverConfig = await this.fetchWifiFromServer();
      
      if (serverConfig.success && serverConfig.hasConfig) {
        // Check if we're already connected to the right WiFi
        if (currentWifi.ssid === serverConfig.ssid) {
          logInfo(`✅ Already connected to server WiFi: ${serverConfig.ssid}`);
          
          if (!hasInternet) {
            logWarning(`⚠️ Connected but no internet, reconnecting...`);
            await this.disconnectWifi();
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Save config first, then connect
            this.saveWifiConfigToFile(serverConfig.ssid, serverConfig.password, 'server');
            await this.connectUsingSavedConfig();
          }
        } else {
          logInfo(`🔄 Switching to server WiFi: ${serverConfig.ssid}`);
          
          // Save config first
          this.saveWifiConfigToFile(serverConfig.ssid, serverConfig.password, 'server');
          
          // Disconnect from current if connected
          if (currentWifi.connected) {
            await this.disconnectWifi();
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          
          // Connect using saved config
          await this.connectUsingSavedConfig();
        }
      } else if (serverConfig.success && !serverConfig.hasConfig) {
        // No server WiFi configured
        logWarning('📡 No server WiFi configuration');
        
        if (currentWifi.connected) {
          // Disconnect from any WiFi since no server config exists
          await this.disconnectWifi();
          logInfo('🚫 Disconnected - no server WiFi configured');
        }
      }
      
      // Get final status
      const finalWifi = await this.getCurrentWifi();
      const finalInternet = await this.testInternet();
      
      logInfo(`📊 WiFi Control Complete: Server WiFi=${finalWifi.connected ? finalWifi.ssid : 'No'}, Internet=${finalInternet}`);
      
      // Reset connection attempts if successful
      if (finalWifi.connected && finalInternet && finalWifi.source === 'server') {
        this.connectionAttempts = 0;
      }
      
    } catch (error) {
      logError('❌ WiFi control error:', error);
      this.connectionAttempts++;
    }
  }

  // Start WiFi monitoring
  startMonitoring() {
    if (this.isMonitoring) {
      logWarning('WiFi monitoring is already running');
      return;
    }

    this.isMonitoring = true;
    logInfo('🚀 Starting server-only WiFi monitoring');

    // Initial control after 5 seconds
    setTimeout(() => {
      this.controlWifi();
    }, 5000);

    // Monitor every 30 seconds
    this.monitorInterval = setInterval(() => {
      this.controlWifi();
    }, 30000);

    logSuccess('✅ Server-only WiFi monitoring started (checks every 30 seconds)');
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

  // Get WiFi status for API
  async getWifiStatus() {
    const currentWifi = await this.getCurrentWifi();
    const hasInternet = await this.testInternet();
    const serverConfig = this.lastServerConfig;
    
    return {
      current_wifi: currentWifi,
      internet: hasInternet,
      server_config: serverConfig,
      local_config: {
        ssid: this.localWifiConfig.ssid,
        source: this.localWifiConfig.source,
        last_updated: this.localWifiConfig.last_updated
      },
      policy: "Only server-configured WiFi allowed",
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
      policy: "server-only",
      checkInterval: '30 seconds'
    };
  }
}

export const wifiManager = new WifiManager();