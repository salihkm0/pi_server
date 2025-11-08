import { exec } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logInfo, logError, logSuccess, logWarning } from "../utils/logger.js";
import { configManager } from "./configManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

// Secure storage for WiFi passwords
const SECURE_STORAGE_PATH = path.join(__dirname, '..', 'config', '.wifi_secure');

class WifiManager {
  constructor() {
    this.isMonitoring = false;
    this.monitorInterval = null;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 5;
    this.encryptionKey = this.getEncryptionKey();
    
    // Your specific default WiFi credentials
    this.defaultWifi = {
      ssid: 'spotus',
      password: 'spotus@123'
    };
    
    this.isMacOS = process.platform === 'darwin';
    this.isLinux = process.platform === 'linux';
  }

  // Get or create encryption key
  getEncryptionKey() {
    const keyPath = path.join(__dirname, '..', 'config', '.encryption_key');
    try {
      if (fs.existsSync(keyPath)) {
        return fs.readFileSync(keyPath, 'utf8').trim();
      } else {
        const key = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(keyPath, key, { mode: 0o600 });
        return key;
      }
    } catch (error) {
      logError('Error handling encryption key:', error);
      return 'fallback_key_rotate_this_in_production';
    }
  }

  // Simple encryption that's compatible
  encrypt(text) {
    try {
      // Use a simple XOR encryption for compatibility
      let result = '';
      for (let i = 0; i < text.length; i++) {
        result += String.fromCharCode(text.charCodeAt(i) ^ this.encryptionKey.charCodeAt(i % this.encryptionKey.length));
      }
      return Buffer.from(result).toString('base64');
    } catch (error) {
      logError('Encryption failed:', error);
      return text; // Fallback to plain text
    }
  }

  // Simple decryption that's compatible
  decrypt(encryptedText) {
    try {
      // First, check if it's already plain text (for migration)
      if (!encryptedText.includes(' ') && encryptedText.length < 50) {
        // Likely plain text password
        return encryptedText;
      }

      try {
        // Try to decode as base64
        const decoded = Buffer.from(encryptedText, 'base64').toString();
        let result = '';
        for (let i = 0; i < decoded.length; i++) {
          result += String.fromCharCode(decoded.charCodeAt(i) ^ this.encryptionKey.charCodeAt(i % this.encryptionKey.length));
        }
        return result;
      } catch (error) {
        // If base64 decoding fails, return as plain text
        return encryptedText;
      }
    } catch (error) {
      logError('Decryption failed, returning as plain text:', error);
      return encryptedText; // Return as plain text on failure
    }
  }

  // Store WiFi credentials securely
  async storeWifiCredentials(ssid, password) {
    try {
      const secureData = {
        ssid: ssid,
        password: this.encrypt(password),
        timestamp: new Date().toISOString(),
        platform: process.platform
      };

      // Ensure secure directory exists
      const secureDir = path.dirname(SECURE_STORAGE_PATH);
      if (!fs.existsSync(secureDir)) {
        fs.mkdirSync(secureDir, { recursive: true, mode: 0o700 });
      }

      // Read existing credentials
      let allCredentials = {};
      if (fs.existsSync(SECURE_STORAGE_PATH)) {
        try {
          const existing = JSON.parse(fs.readFileSync(SECURE_STORAGE_PATH, 'utf8'));
          allCredentials = existing;
        } catch (error) {
          logError('Error reading existing credentials, creating new file:', error);
        }
      }

      // Update credentials for this SSID
      allCredentials[ssid] = secureData;

      // Write securely
      fs.writeFileSync(SECURE_STORAGE_PATH, JSON.stringify(allCredentials, null, 2), {
        mode: 0o600
      });

      logSuccess(`WiFi credentials stored securely for: ${ssid}`);
      return true;
    } catch (error) {
      logError('Error storing WiFi credentials:', error);
      return false;
    }
  }

  // Retrieve WiFi credentials securely
  getStoredWifiCredentials(ssid) {
    try {
      if (!fs.existsSync(SECURE_STORAGE_PATH)) {
        return null;
      }

      const allCredentials = JSON.parse(fs.readFileSync(SECURE_STORAGE_PATH, 'utf8'));
      const credentials = allCredentials[ssid];

      if (credentials && credentials.password) {
        const decryptedPassword = this.decrypt(credentials.password);
        
        if (decryptedPassword) {
          return {
            ssid: credentials.ssid,
            password: decryptedPassword,
            timestamp: credentials.timestamp
          };
        }
      }
      return null;
    } catch (error) {
      logError('Error retrieving WiFi credentials:', error);
      return null;
    }
  }

  // Get default WiFi credentials
  getDefaultWifi() {
    return this.defaultWifi;
  }

  // Initialize default WiFi on first run
  async initializeDefaultWifi() {
    try {
      const config = await configManager.loadConfig();
      
      // Check if we already have stored WiFi credentials
      const storedNetworks = this.getAllStoredNetworks();
      if (storedNetworks.length === 0) {
        logInfo('No stored WiFi networks found. Setting up default WiFi...');
        
        // Store your specific default WiFi credentials
        await this.storeWifiCredentials(this.defaultWifi.ssid, this.defaultWifi.password);
        
        // Update device config
        await configManager.updateConfig({
          wifi: {
            defaultSsid: this.defaultWifi.ssid,
            autoConnect: true,
            fallbackToDefault: true,
            platform: process.platform,
            initialized: new Date().toISOString()
          }
        });
        
        logSuccess(`✅ Default WiFi configured: ${this.defaultWifi.ssid}`);
        return true;
      } else {
        logInfo(`📡 Found ${storedNetworks.length} stored WiFi networks`);
        return false;
      }
    } catch (error) {
      logError('Error initializing default WiFi:', error);
      return false;
    }
  }

  // Get all stored networks
  getAllStoredNetworks() {
    try {
      if (!fs.existsSync(SECURE_STORAGE_PATH)) {
        return [];
      }

      const allCredentials = JSON.parse(fs.readFileSync(SECURE_STORAGE_PATH, 'utf8'));
      return Object.keys(allCredentials);
    } catch (error) {
      logError('Error getting stored networks:', error);
      return [];
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

  // macOS specific WiFi commands
  async connectToWifiMacOS(ssid, password) {
    try {
      logInfo(`📡 Connecting to WiFi on macOS: ${ssid}`);
      
      // First, check if we're already connected
      const currentNetwork = await this.getCurrentWifiMacOS();
      if (currentNetwork.ssid === ssid) {
        logInfo(`✅ Already connected to: ${ssid}`);
        return { success: true, ssid };
      }
      
      // Try to connect using networksetup (macOS)
      const commands = [
        `networksetup -setairportnetwork en0 "${ssid}" "${password}"`,
        `networksetup -setairportnetwork en1 "${ssid}" "${password}"`
      ];
      
      for (const cmd of commands) {
        try {
          await execAsync(cmd, { timeout: 30000 });
          logSuccess(`✅ Connected to WiFi on macOS: ${ssid}`);
          return { success: true, ssid };
        } catch (error) {
          continue;
        }
      }
      
      throw new Error('Failed to connect using networksetup');
      
    } catch (error) {
      logError(`❌ macOS WiFi connection failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // Get current WiFi on macOS
  async getCurrentWifiMacOS() {
    try {
      const { stdout } = await execAsync('/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -I');
      const lines = stdout.split('\n');
      
      for (const line of lines) {
        if (line.includes(' SSID:')) {
          const ssid = line.split(':')[1].trim();
          return {
            connected: true,
            ssid: ssid,
            signal: 100,
            state: 'connected'
          };
        }
      }
      
      return {
        connected: false,
        ssid: null,
        signal: 0,
        state: 'disconnected'
      };
    } catch (error) {
      return {
        connected: false,
        ssid: null,
        signal: 0,
        state: 'error'
      };
    }
  }

  // Scan networks on macOS
  async scanNetworksMacOS() {
    try {
      const { stdout } = await execAsync('/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -s');
      const lines = stdout.split('\n').slice(1);
      
      const networks = lines.map(line => {
        const parts = line.trim().split(/\s+/);
        const ssid = parts[0];
        const signal = parseInt(parts[1]) || 0;
        
        return {
          ssid: ssid,
          signal: signal,
          security: 'unknown',
          frequency: '2.4/5GHz',
          quality: this.getSignalQuality(signal),
          isStored: this.getStoredWifiCredentials(ssid) !== null
        };
      }).filter(network => network.ssid && network.ssid !== '');
      
      return networks;
    } catch (error) {
      logError('macOS network scan failed:', error);
      return [];
    }
  }

  // Enhanced WiFi connection with platform detection
  async connectToWifi(ssid, password, storeCredentials = true) {
    try {
      logInfo(`📡 Connecting to WiFi: ${ssid} (Platform: ${process.platform})`);
      
      // Validate inputs
      if (!ssid || ssid.trim().length === 0) {
        throw new Error('SSID cannot be empty');
      }

      if (!password) {
        throw new Error('Password cannot be empty');
      }

      let result;
      
      if (this.isMacOS) {
        result = await this.connectToWifiMacOS(ssid, password);
      } else if (this.isLinux) {
        result = await this.connectToWifiLinux(ssid, password);
      } else {
        throw new Error(`Unsupported platform: ${process.platform}`);
      }

      if (result.success) {
        // Store credentials securely if requested
        if (storeCredentials) {
          await this.storeWifiCredentials(ssid, password);
        }

        // Update device config
        await configManager.updateWifiConfig(ssid);

        // Reset connection attempts on success
        this.connectionAttempts = 0;

        return {
          success: true,
          ssid: ssid,
          message: `✅ Connected to ${ssid} successfully`,
          platform: process.platform
        };
      } else {
        throw new Error(result.error);
      }

    } catch (error) {
      logError(`❌ Failed to connect to WiFi ${ssid}:`, error.message);
      
      // Increment connection attempts
      this.connectionAttempts++;

      return {
        success: false,
        error: error.message,
        ssid: ssid,
        details: error.message,
        attempts: this.connectionAttempts,
        platform: process.platform
      };
    }
  }

  // Linux specific WiFi connection
  async connectToWifiLinux(ssid, password) {
    try {
      // Check if NetworkManager is available
      const nmAvailable = await this.checkNetworkManager();
      if (!nmAvailable) {
        throw new Error('NetworkManager (nmcli) is not available');
      }

      // Delete existing connection if it exists
      try {
        await execAsync(`nmcli connection delete "${ssid}"`);
      } catch (error) {
        // Ignore errors if connection doesn't exist
      }

      // Connect to WiFi with timeout
      const { stdout, stderr } = await execAsync(
        `nmcli device wifi connect "${ssid}" password "${password}"`,
        { timeout: 30000 }
      );

      if (stderr && !stdout.includes('successfully activated')) {
        throw new Error(stderr);
      }

      return { success: true, ssid };

    } catch (error) {
      throw new Error(`Linux connection failed: ${error.message}`);
    }
  }

  // Enhanced auto-connect with stored credentials
  async connectToStoredWifi() {
    try {
      const storedNetworks = this.getAllStoredNetworks();
      
      if (storedNetworks.length === 0) {
        logWarning('❌ No stored WiFi networks available');
        return false;
      }

      // Check current connection first
      const currentWifi = await this.getCurrentWifi();
      if (currentWifi.connected) {
        logInfo(`✅ Already connected to: ${currentWifi.ssid}`);
        return true;
      }

      // Try each stored network
      for (const ssid of storedNetworks) {
        logInfo(`🔄 Attempting to connect to stored network: ${ssid}`);
        
        const storedCredentials = this.getStoredWifiCredentials(ssid);
        if (storedCredentials && storedCredentials.password) {
          const result = await this.connectToWifi(ssid, storedCredentials.password, false);
          
          if (result.success) {
            logSuccess(`✅ Auto-connected to ${ssid}`);
            return true;
          } else {
            logWarning(`❌ Failed to auto-connect to ${ssid}: ${result.error}`);
          }
        } else {
          logWarning(`❌ No valid credentials found for: ${ssid}`);
        }
      }

      logError('❌ Could not connect to any stored WiFi network');
      return false;

    } catch (error) {
      logError('❌ Error in auto-connect:', error);
      return false;
    }
  }

  // Connect to default WiFi as fallback
  async connectToDefaultWifi() {
    try {
      logInfo('🔄 Attempting to connect to default WiFi...');
      
      const result = await this.connectToWifi(
        this.defaultWifi.ssid, 
        this.defaultWifi.password, 
        false
      );
      
      if (result.success) {
        logSuccess(`✅ Connected to default WiFi: ${this.defaultWifi.ssid}`);
      } else {
        logError(`❌ Failed to connect to default WiFi: ${result.error}`);
      }
      
      return result;
    } catch (error) {
      logError('❌ Error connecting to default WiFi:', error);
      return { success: false, error: error.message };
    }
  }

  // Get current WiFi connection info
  async getCurrentWifi() {
    try {
      if (this.isMacOS) {
        return await this.getCurrentWifiMacOS();
      } else if (this.isLinux) {
        return await this.getCurrentWifiLinux();
      } else {
        return {
          connected: false,
          ssid: null,
          signal: 0,
          error: `Unsupported platform: ${process.platform}`
        };
      }
    } catch (error) {
      logError('❌ Error getting current WiFi:', error);
      return {
        connected: false,
        ssid: null,
        signal: 0,
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
        const connectionInfo = await this.getConnectionStats();
        
        return {
          connected: true,
          ssid: ssid,
          signal: signal,
          ipAddress: connectionInfo.ipAddress,
          gateway: connectionInfo.gateway,
          state: connectionInfo.state
        };
      } else {
        return {
          connected: false,
          ssid: null,
          signal: 0,
          ipAddress: null,
          gateway: null,
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

  // Get WiFi signal strength
  async getWifiSignal(ssid) {
    try {
      if (this.isMacOS) {
        return 80;
      } else {
        const { stdout } = await execAsync(`nmcli -t -f ssid,signal dev wifi | grep "${ssid}:" | cut -d: -f2`);
        return parseInt(stdout.trim()) || 0;
      }
    } catch (error) {
      return 0;
    }
  }

  // Enhanced network scanning with platform detection
  async scanNetworks() {
    try {
      logInfo('📡 Scanning for available networks...');
      
      if (this.isMacOS) {
        return await this.scanNetworksMacOS();
      } else if (this.isLinux) {
        return await this.scanNetworksLinux();
      } else {
        logWarning(`❌ Network scanning not supported on platform: ${process.platform}`);
        return [];
      }
    } catch (error) {
      logError('❌ Error scanning networks:', error);
      return [];
    }
  }

  // Scan networks on Linux
  async scanNetworksLinux() {
    try {
      await execAsync('nmcli dev wifi rescan');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const { stdout } = await execAsync('nmcli -t -f ssid,signal,security,freq dev wifi');
      const networks = stdout.trim().split('\n')
        .filter(line => line && !line.startsWith('--:'))
        .map(line => {
          const [ssid, signal, security, frequency] = line.split(':');
          return {
            ssid: ssid || 'Unknown',
            signal: parseInt(signal) || 0,
            security: security || 'none',
            frequency: frequency || 'Unknown',
            quality: this.getSignalQuality(parseInt(signal) || 0),
            isStored: this.getStoredWifiCredentials(ssid) !== null
          };
        })
        .filter(network => network.ssid && network.ssid !== '' && network.ssid !== 'Unknown')
        .sort((a, b) => b.signal - a.signal);
      
      logInfo(`📡 Found ${networks.length} networks`);
      return networks;
    } catch (error) {
      logError('❌ Linux network scan failed:', error);
      return [];
    }
  }

  // Get signal quality category
  getSignalQuality(signal) {
    if (signal >= 80) return 'Excellent';
    if (signal >= 60) return 'Good';
    if (signal >= 40) return 'Fair';
    if (signal >= 20) return 'Weak';
    return 'Very Weak';
  }

  // Enhanced disconnect with platform detection
  async disconnectWifi() {
    try {
      const currentWifi = await this.getCurrentWifi();
      
      if (currentWifi.connected) {
        if (this.isMacOS) {
          await execAsync('networksetup -setairportpower en0 off');
          await new Promise(resolve => setTimeout(resolve, 2000));
          await execAsync('networksetup -setairportpower en0 on');
        } else if (this.isLinux) {
          await execAsync(`nmcli connection down "${currentWifi.ssid}"`);
        }
        
        logSuccess(`✅ Disconnected from WiFi: ${currentWifi.ssid}`);
        
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
      logError('❌ Error disconnecting WiFi:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Remove stored credentials
  async removeStoredCredentials(ssid) {
    try {
      if (fs.existsSync(SECURE_STORAGE_PATH)) {
        const allCredentials = JSON.parse(fs.readFileSync(SECURE_STORAGE_PATH, 'utf8'));
        delete allCredentials[ssid];
        fs.writeFileSync(SECURE_STORAGE_PATH, JSON.stringify(allCredentials, null, 2), {
          mode: 0o600
        });
        logInfo(`🗑️ Removed stored credentials for: ${ssid}`);
      }
    } catch (error) {
      logError('❌ Error removing stored credentials:', error);
    }
  }

  // Enhanced monitoring with auto-reconnection
  startMonitoring() {
    if (this.isMonitoring) {
      logWarning('📡 WiFi monitoring is already running');
      return;
    }

    this.isMonitoring = true;
    this.connectionAttempts = 0;

    logInfo(`📡 Starting WiFi auto-connection monitoring (Platform: ${process.platform})...`);

    // Initial connection attempt
    setTimeout(() => {
      this.attemptAutoConnection();
    }, 5000);

    // Monitor every minute
    this.monitorInterval = setInterval(() => {
      this.attemptAutoConnection();
    }, 60000); // Check every minute

    logInfo('✅ WiFi auto-connection monitoring started');
  }

  // Attempt auto-connection to stored WiFi
  async attemptAutoConnection() {
    try {
      const currentWifi = await this.getCurrentWifi();
      const internetStatus = await this.testInternet();
      
      if (currentWifi.connected && internetStatus) {
        // Everything is good, reset attempts
        this.connectionAttempts = 0;
        logInfo(`✅ WiFi connected: ${currentWifi.ssid}, Internet: OK`);
        return;
      }

      if (this.connectionAttempts >= this.maxConnectionAttempts) {
        logWarning(`❌ Max connection attempts (${this.maxConnectionAttempts}) reached. Waiting before retry...`);
        return;
      }

      logWarning(`🔄 Connection issue detected. Attempts: ${this.connectionAttempts + 1}/${this.maxConnectionAttempts}`);

      if (!currentWifi.connected || !internetStatus) {
        logInfo('🔄 Attempting auto-connection to stored WiFi...');
        
        // Try stored networks first
        const connected = await this.connectToStoredWifi();
        
        if (!connected) {
          this.connectionAttempts++;
          logWarning(`❌ Auto-connection failed. Attempt ${this.connectionAttempts}`);
          
          // Try default WiFi as fallback
          if (this.connectionAttempts >= 2) {
            logInfo('🔄 Trying default WiFi as fallback...');
            await this.connectToDefaultWifi();
          }
        } else {
          this.connectionAttempts = 0;
          logSuccess('✅ Auto-connection successful');
        }
      }

    } catch (error) {
      logError('❌ WiFi monitoring error:', error);
      this.connectionAttempts++;
    }
  }

  stopMonitoring() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.isMonitoring = false;
    this.connectionAttempts = 0;
    logInfo('🛑 WiFi monitoring stopped');
  }

  // Enhanced internet test with multiple endpoints
  async testInternet() {
    const testEndpoints = [
      'https://www.google.com',
      'https://www.cloudflare.com',
      'https://www.apple.com'
    ];

    for (const endpoint of testEndpoints) {
      try {
        const { default: axios } = await import('axios');
        await axios.get(endpoint, { timeout: 10000 });
        logSuccess(`🌐 Internet connectivity confirmed via ${endpoint}`);
        return true;
      } catch (error) {
        continue;
      }
    }
    
    logWarning('🌐 No internet connection available');
    return false;
  }

  // Get connection statistics
  async getConnectionStats() {
    try {
      if (this.isMacOS) {
        const { stdout } = await execAsync('ipconfig getifaddr en0');
        const ipAddress = stdout.trim();
        
        return {
          connected: true,
          ipAddress: ipAddress || 'Unknown',
          gateway: 'Unknown',
          state: 'connected'
        };
      } else {
        const { stdout } = await execAsync('nmcli -t -f general.state,ip4.address,ip4.gateway dev show $(nmcli -t -f device,type dev status | grep wifi: | cut -d: -f1)');
        const stats = {};
        
        stdout.trim().split('\n').forEach(line => {
          const [key, value] = line.split(':');
          if (key && value) {
            stats[key] = value;
          }
        });

        return {
          connected: stats['GENERAL.STATE'] === '100 (connected)',
          ipAddress: stats['IP4.ADDRESS[1]'] || 'Unknown',
          gateway: stats['IP4.GATEWAY'] || 'Unknown',
          state: stats['GENERAL.STATE'] || 'Unknown'
        };
      }
    } catch (error) {
      return {
        connected: false,
        ipAddress: 'Unknown',
        gateway: 'Unknown',
        state: 'Error'
      };
    }
  }

  // Get monitoring status
  getMonitoringStatus() {
    return {
      isMonitoring: this.isMonitoring,
      connectionAttempts: this.connectionAttempts,
      maxConnectionAttempts: this.maxConnectionAttempts,
      storedNetworks: this.getAllStoredNetworks(),
      defaultSsid: this.defaultWifi.ssid,
      platform: process.platform,
      networkManagerAvailable: this.isLinux ? 'checking' : 'n/a'
    };
  }
}

export const wifiManager = new WifiManager();