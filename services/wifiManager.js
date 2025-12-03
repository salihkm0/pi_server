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

// Secure storage for installation WiFi only
const WIFI_STORAGE_PATH = path.join(__dirname, '..', 'config', '.wifi_install');
const ENCRYPTION_KEY_PATH = path.join(__dirname, '..', 'config', '.wifi_key');

class WifiManager {
  constructor() {
    this.isMonitoring = false;
    this.monitorInterval = null;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 3; // Reduced attempts
    this.currentWifiSsid = null;
    this.serverWifiConfigured = false;
    this.lastServerCheck = null;
    this.encryptionKey = this.getOrCreateEncryptionKey();
    this.isLinux = process.platform === 'linux';
    this.isMacOS = process.platform === 'darwin';
    
    // Installation WiFi only - used during setup
    this.installationWifi = null;
  }

  // Get or create encryption key for installation WiFi storage
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

  // Simple XOR encryption for installation WiFi
  encrypt(text) {
    let result = '';
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i) ^ this.encryptionKey.charCodeAt(i % this.encryptionKey.length);
      result += String.fromCharCode(charCode);
    }
    return Buffer.from(result).toString('base64');
  }

  decrypt(encryptedText) {
    try {
      const decoded = Buffer.from(encryptedText, 'base64').toString();
      let result = '';
      for (let i = 0; i < decoded.length; i++) {
        const charCode = decoded.charCodeAt(i) ^ this.encryptionKey.charCodeAt(i % this.encryptionKey.length);
        result += String.fromCharCode(charCode);
      }
      return result;
    } catch (error) {
      logError('Decryption failed:', error);
      return null;
    }
  }

  // Store installation WiFi credentials (only for setup)
  storeInstallationWifi(ssid, password) {
    try {
      const installData = {
        ssid: ssid,
        password: this.encrypt(password),
        timestamp: new Date().toISOString(),
        source: 'installation',
        note: 'For initial setup only'
      };

      fs.writeFileSync(WIFI_STORAGE_PATH, JSON.stringify(installData, null, 2), {
        mode: 0o600
      });

      this.installationWifi = { ssid, password };
      logSuccess(`Installation WiFi stored: ${ssid}`);
      return true;
    } catch (error) {
      logError('Error storing installation WiFi:', error);
      return false;
    }
  }

  // Get installation WiFi credentials
  getInstallationWifi() {
    try {
      if (!fs.existsSync(WIFI_STORAGE_PATH)) {
        return null;
      }

      const installData = JSON.parse(fs.readFileSync(WIFI_STORAGE_PATH, 'utf8'));
      if (installData && installData.password) {
        const decryptedPassword = this.decrypt(installData.password);
        if (decryptedPassword) {
          this.installationWifi = {
            ssid: installData.ssid,
            password: decryptedPassword,
            timestamp: installData.timestamp,
            source: installData.source
          };
          return this.installationWifi;
        }
      }
      return null;
    } catch (error) {
      logError('Error reading installation WiFi:', error);
      return null;
    }
  }

  // Clear installation WiFi storage
  clearInstallationWifi() {
    try {
      if (fs.existsSync(WIFI_STORAGE_PATH)) {
        fs.unlinkSync(WIFI_STORAGE_PATH);
      }
      this.installationWifi = null;
      logInfo('Installation WiFi credentials cleared');
    } catch (error) {
      logError('Error clearing installation WiFi:', error);
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

  // Fetch WiFi configuration from central server
  async fetchWifiFromServer() {
    try {
      const axios = await import('axios');
      logInfo(`Fetching WiFi configuration from central server for device: ${RPI_ID}`);
      
      const response = await axios.default.get(`${SERVER_URL}/api/devices/wifi-config/${RPI_ID}`, {
        timeout: 10000, // Reduced timeout
        headers: {
          'User-Agent': `ADS-Display/${RPI_ID}`,
          'Accept': 'application/json'
        }
      });

      if (response.data.success && response.data.has_wifi_config) {
        const { wifi_ssid, wifi_password } = response.data;
        logSuccess(`Received WiFi configuration from server: ${wifi_ssid}`);
        
        this.serverWifiConfigured = true;
        this.lastServerCheck = new Date();
        
        return {
          success: true,
          ssid: wifi_ssid,
          password: wifi_password,
          source: 'server',
          hasConfig: true
        };
      } else {
        logInfo('No WiFi configuration found on central server');
        this.serverWifiConfigured = false;
        this.lastServerCheck = new Date();
        
        return {
          success: true,
          hasConfig: false,
          source: 'server'
        };
      }
    } catch (error) {
      logError('Failed to fetch WiFi configuration from server:', error.message);
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
      logInfo(`Attempting to connect to WiFi: ${ssid} (Source: ${source})`);
      
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
      logError(`Failed to connect to WiFi ${ssid}:`, error.message);
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
        { timeout: 20000 } // Reduced timeout
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
      logInfo(`Connecting to WiFi on macOS: ${ssid}`);
      
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

  // Main WiFi control logic - UPDATED per requirements
  async controlWifi() {
    try {
      logInfo('🔄 Starting WiFi control cycle...');
      
      // Step 1: Get current WiFi connection
      const currentWifi = await this.getCurrentWifi();
      const hasInternet = await this.testInternet();
      
      logInfo(`Current: WiFi=${currentWifi.ssid || 'None'}, Internet=${hasInternet}`);
      
      // Step 2: Fetch WiFi configuration from server
      const serverConfig = await this.fetchWifiFromServer();
      
      if (!serverConfig.success) {
        // If can't reach server, continue with current WiFi
        logWarning('Cannot reach server, continuing with current WiFi');
        return;
      }
      
      // Step 3: Apply logic based on server configuration
      if (serverConfig.hasConfig) {
        // Server has WiFi configuration
        if (currentWifi.ssid === serverConfig.ssid) {
          // Already connected to server WiFi
          if (hasInternet) {
            logInfo(`✅ Connected to server WiFi (${serverConfig.ssid}) with internet`);
          } else {
            logWarning(`⚠️ Connected to server WiFi but no internet - will retry`);
            // Reconnect to server WiFi
            await this.disconnectWifi();
            await new Promise(resolve => setTimeout(resolve, 3000));
            await this.connectToWifi(serverConfig.ssid, serverConfig.password, 'server-retry');
          }
        } else {
          // Connected to different WiFi - switch to server WiFi
          logInfo(`🔄 Switching to server WiFi: ${serverConfig.ssid}`);
          
          // Try to connect to server WiFi
          const connectResult = await this.connectToWifi(
            serverConfig.ssid, 
            serverConfig.password, 
            'server'
          );
          
          if (connectResult.success) {
            logSuccess(`✅ Connected to server WiFi: ${serverConfig.ssid}`);
          } else {
            logError(`❌ Failed to connect to server WiFi: ${connectResult.error}`);
            
            // If server WiFi fails, try to reconnect to current WiFi
            if (currentWifi.connected) {
              logInfo(`🔄 Reconnecting to previous WiFi: ${currentWifi.ssid}`);
              
              // Try installation WiFi first
              const installWifi = this.getInstallationWifi();
              if (installWifi) {
                await this.connectToWifi(installWifi.ssid, installWifi.password, 'installation-fallback');
              }
            }
          }
        }
      } else {
        // Server has no WiFi configuration
        logInfo('ℹ️ No WiFi configuration on server');
        
        if (currentWifi.connected) {
          // Continue with current WiFi
          if (hasInternet) {
            logInfo(`✅ Continuing with current WiFi: ${currentWifi.ssid}`);
          } else {
            logWarning(`⚠️ No internet on current WiFi: ${currentWifi.ssid}`);
            
            // Try installation WiFi if available
            const installWifi = this.getInstallationWifi();
            if (installWifi && currentWifi.ssid !== installWifi.ssid) {
              logInfo(`🔄 Trying installation WiFi: ${installWifi.ssid}`);
              await this.connectToWifi(installWifi.ssid, installWifi.password, 'installation-retry');
            }
          }
        } else {
          // Not connected to any WiFi - try installation WiFi
          const installWifi = this.getInstallationWifi();
          if (installWifi) {
            logInfo(`🔄 Connecting to installation WiFi: ${installWifi.ssid}`);
            await this.connectToWifi(installWifi.ssid, installWifi.password, 'installation');
          } else {
            logWarning('⚠️ No WiFi connection available');
          }
        }
      }
      
      // Reset connection attempts if successful
      const finalWifi = await this.getCurrentWifi();
      const finalInternet = await this.testInternet();
      
      if (finalWifi.connected && finalInternet) {
        this.connectionAttempts = 0;
      }
      
    } catch (error) {
      logError('WiFi control error:', error);
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
    logInfo('🚀 Starting WiFi monitoring service');

    // Load installation WiFi if exists
    this.getInstallationWifi();

    // Initial control after 10 seconds
    setTimeout(() => {
      this.controlWifi();
    }, 10000);

    // Monitor every minute (60 seconds)
    this.monitorInterval = setInterval(() => {
      this.controlWifi();
    }, 60000);

    logSuccess('✅ WiFi monitoring started (checks every 60 seconds)');
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

  // Manual connection for installation
  async manualConnect(ssid, password) {
    try {
      logInfo(`Manual connection for installation: ${ssid}`);
      
      // Store as installation WiFi
      this.storeInstallationWifi(ssid, password);
      
      // Connect
      const result = await this.connectToWifi(ssid, password, 'installation');
      
      if (result.success) {
        logSuccess(`✅ Installation connection successful: ${ssid}`);
      }
      
      return result;
    } catch (error) {
      logError('Manual connection error:', error);
      return {
        success: false,
        error: error.message
      };
    }
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
      hasInstallationWifi: this.installationWifi !== null,
      platform: process.platform,
      checkInterval: '60 seconds'
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