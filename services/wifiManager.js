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
const WIFI_CONNECTION_HISTORY_PATH = path.join(__dirname, '..', 'config', '.wifi_history.json');

class WifiManager {
  constructor() {
    this.isMonitoring = false;
    this.monitorInterval = null;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 5; // Increased attempts
    this.currentWifiSsid = null;
    this.serverWifiConfigured = false;
    this.lastServerCheck = null;
    this.lastServerConfig = null;
    this.encryptionKey = this.getOrCreateEncryptionKey();
    this.isLinux = process.platform === 'linux';
    this.isMacOS = process.platform === 'darwin';
    this.useSudo = true; // Always use sudo for reliability
    this.currentUser = process.env.USER || 'pi';
    this.lastNetworkScan = null;
    this.scanCacheDuration = 30000;
    this.scanCache = [];
    this.fallbackWifiSsid = null;
    this.fallbackWifiPassword = null;
    this.connectionHistory = this.loadConnectionHistory();
    
    // Load local WiFi config (only from server)
    this.localWifiConfig = this.loadLocalWifiConfig();
    
    // Load fallback from history
    this.loadFallbackFromHistory();
  }

  // Load connection history
  loadConnectionHistory() {
    try {
      if (fs.existsSync(WIFI_CONNECTION_HISTORY_PATH)) {
        const data = JSON.parse(fs.readFileSync(WIFI_CONNECTION_HISTORY_PATH, 'utf8'));
        return data;
      }
    } catch (error) {
      logError('Error loading connection history:', error);
    }
    return { connections: [], lastSuccessful: null };
  }

  // Save connection history
  saveConnectionHistory() {
    try {
      const configDir = path.dirname(WIFI_CONNECTION_HISTORY_PATH);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      
      fs.writeFileSync(WIFI_CONNECTION_HISTORY_PATH, JSON.stringify(this.connectionHistory, null, 2), {
        mode: 0o600
      });
    } catch (error) {
      logError('Error saving connection history:', error);
    }
  }

  // Record successful connection
  recordSuccessfulConnection(ssid, source) {
    try {
      const connection = {
        ssid: ssid,
        source: source,
        timestamp: new Date().toISOString(),
        successful: true
      };
      
      // Add to history
      this.connectionHistory.connections.unshift(connection);
      
      // Keep only last 10 connections
      if (this.connectionHistory.connections.length > 10) {
        this.connectionHistory.connections = this.connectionHistory.connections.slice(0, 10);
      }
      
      // Update last successful
      this.connectionHistory.lastSuccessful = {
        ssid: ssid,
        source: source,
        timestamp: new Date().toISOString()
      };
      
      this.saveConnectionHistory();
      logInfo(`📝 Recorded successful connection to: ${ssid}`);
    } catch (error) {
      logError('Error recording connection:', error);
    }
  }

  // Load fallback WiFi from history
  loadFallbackFromHistory() {
    try {
      if (this.connectionHistory.lastSuccessful) {
        const lastSsid = this.connectionHistory.lastSuccessful.ssid;
        
        // Don't use server WiFi as fallback (we're trying to connect to it)
        if (lastSsid !== this.localWifiConfig.ssid) {
          this.fallbackWifiSsid = lastSsid;
          logInfo(`📋 Loaded fallback WiFi from history: ${lastSsid}`);
          
          // Try to find password in local config
          const localConfig = this.loadLocalWifiConfig();
          if (localConfig.ssid === lastSsid) {
            this.fallbackWifiPassword = localConfig.password;
          }
        }
      }
    } catch (error) {
      logError('Error loading fallback from history:', error);
    }
  }

  // Execute command with sudo (always use sudo for reliability)
  async executeCommand(command, timeout = 15000) {
    try {
      const cmd = `sudo ${command}`;
      // Mask passwords in logs
      const maskedCmd = cmd.replace(/password ".*?"/g, 'password "********"');
      logInfo(`🔧 Executing: ${maskedCmd}`);
      
      const { stdout, stderr } = await execAsync(cmd, { timeout });
      
      if (stderr && !stderr.includes('Warning:')) {
        logWarning(`⚠️ Command stderr: ${stderr}`);
      }
      
      return { stdout, stderr };
    } catch (error) {
      logError(`❌ Command failed: ${error.message}`);
      throw error;
    }
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
      return true;
    } catch (error) {
      logError('❌ Error saving WiFi config to file:', error);
      return false;
    }
  }

  // Escape SSID for shell commands
  escapeSsid(ssid) {
    // Escape single quotes and wrap in single quotes
    return `'${ssid.replace(/'/g, "'\"'\"'")}'`;
  }

  // Improved scan for available WiFi networks
  async scanNetworks(forceRefresh = false) {
    try {
      // Use cache if available and not expired
      const now = Date.now();
      if (!forceRefresh && 
          this.lastNetworkScan && 
          (now - this.lastNetworkScan) < this.scanCacheDuration &&
          this.scanCache.length > 0) {
        logInfo(`📡 Using cached network scan (${this.scanCache.length} networks)`);
        return this.scanCache;
      }
      
      logInfo('📡 Scanning for WiFi networks...');
      
      if (this.isLinux) {
        // Ensure WiFi is enabled
        try {
          await this.executeCommand('nmcli radio wifi on');
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          logWarning(`⚠️ Could not enable WiFi radio: ${error.message}`);
        }
        
        // Scan for networks
        try {
          await this.executeCommand('nmcli device wifi rescan', 10000);
          await new Promise(resolve => setTimeout(resolve, 3000));
        } catch (error) {
          logWarning(`⚠️ Rescan failed: ${error.message}`);
        }
        
        // Get list of networks
        const { stdout } = await this.executeCommand('nmcli -t -f SSID,SIGNAL dev wifi');
        const lines = stdout.trim().split('\n').filter(line => line);
        
        const networks = [];
        for (const line of lines) {
          const [ssid, signalStr] = line.split(':');
          if (ssid && ssid !== '--') {
            networks.push({
              ssid: ssid,
              signal: parseInt(signalStr) || 0
            });
          }
        }
        
        // Update cache
        this.scanCache = networks;
        this.lastNetworkScan = now;
        
        logInfo(`✅ Found ${networks.length} WiFi networks`);
        
        // Debug: List all found networks
        if (networks.length > 0) {
          logInfo('📶 Available networks:');
          networks.forEach(network => {
            logInfo(`  - ${network.ssid} (signal: ${network.signal}%)`);
          });
        }
        
        return networks;
      }
      
      return [];
    } catch (error) {
      logError('Error scanning networks:', error);
      return [];
    }
  }

  // Enhanced check if network is available
  async isNetworkAvailable(ssid) {
    try {
      const networks = await this.scanNetworks();
      const found = networks.some(network => network.ssid === ssid);
      
      if (found) {
        logInfo(`✅ Network "${ssid}" is available`);
      } else {
        logInfo(`❌ Network "${ssid}" not found in scan`);
      }
      
      return found;
    } catch (error) {
      logError(`Error checking network availability for ${ssid}:`, error);
      return false;
    }
  }

  // Persistent attempt to connect to configured WiFi
  async connectToConfiguredWifi() {
    const config = this.loadLocalWifiConfig();
    
    if (!config.ssid || !config.password) {
      logError('❌ No configured WiFi found in local file');
      return { success: false, error: 'No configured WiFi' };
    }
    
    logInfo(`🔗 Persistent attempt to connect to configured WiFi: ${config.ssid}`);
    
    // Check if network is available
    const isAvailable = await this.isNetworkAvailable(config.ssid);
    
    if (!isAvailable) {
      logWarning(`⚠️ Configured WiFi "${config.ssid}" not available`);
      return { 
        success: false, 
        error: `Network "${config.ssid}" not available`,
        retry: true // Indicate we should retry later
      };
    }
    
    // Try to connect
    const result = await this.connectToWifiDirect(
      config.ssid,
      config.password,
      'configured-retry'
    );
    
    if (result.success) {
      logSuccess(`✅ Connected to configured WiFi: ${config.ssid}`);
      this.recordSuccessfulConnection(config.ssid, 'configured');
      return result;
    }
    
    return result;
  }

  // Connect to fallback WiFi (last successful non-server WiFi)
  async connectToFallbackWifi() {
    if (!this.fallbackWifiSsid) {
      logInfo('No fallback WiFi available');
      return { success: false, error: 'No fallback WiFi' };
    }
    
    // Don't fallback to server WiFi (we're trying to connect to it)
    if (this.fallbackWifiSsid === this.localWifiConfig.ssid) {
      logInfo('Fallback is same as configured WiFi, skipping');
      return { success: false, error: 'Fallback same as target' };
    }
    
    logInfo(`🔗 Connecting to fallback WiFi: ${this.fallbackWifiSsid}`);
    
    // We need password for fallback - if we don't have it, we can't connect
    if (!this.fallbackWifiPassword) {
      logWarning(`⚠️ No password for fallback WiFi: ${this.fallbackWifiSsid}`);
      return { success: false, error: 'No password for fallback' };
    }
    
    const result = await this.connectToWifiDirect(
      this.fallbackWifiSsid,
      this.fallbackWifiPassword,
      'fallback'
    );
    
    if (result.success) {
      logSuccess(`✅ Connected to fallback WiFi: ${this.fallbackWifiSsid}`);
      this.recordSuccessfulConnection(this.fallbackWifiSsid, 'fallback');
    }
    
    return result;
  }

  // Main WiFi connection strategy
  async executeWifiConnectionStrategy() {
    logInfo('🚀 Executing WiFi connection strategy...');
    
    // Step 1: Get current status
    const currentWifi = await this.getCurrentWifi();
    const hasInternet = await this.testInternet();
    
    logInfo(`📊 Current: WiFi=${currentWifi.ssid || 'None'}, Internet=${hasInternet}`);
    
    // If already connected to configured WiFi with internet, we're good
    if (currentWifi.connected && 
        currentWifi.ssid === this.localWifiConfig.ssid && 
        hasInternet) {
      logInfo(`✅ Already connected to configured WiFi with internet: ${currentWifi.ssid}`);
      this.recordSuccessfulConnection(currentWifi.ssid, 'current');
      return { success: true, connectedTo: 'configured', ssid: currentWifi.ssid };
    }
    
    // Step 2: Try to connect to configured WiFi
    logInfo('🔄 Step 1: Trying configured WiFi...');
    const configuredResult = await this.connectToConfiguredWifi();
    
    if (configuredResult.success) {
      const internetAfter = await this.testInternet();
      if (internetAfter) {
        logSuccess(`✅ Connected to configured WiFi with internet: ${configuredResult.ssid}`);
        return { success: true, connectedTo: 'configured', ssid: configuredResult.ssid };
      } else {
        logWarning(`⚠️ Connected to configured WiFi but no internet: ${configuredResult.ssid}`);
      }
    }
    
    // Step 3: If configured WiFi failed but we have internet from current WiFi, stay connected
    if (currentWifi.connected && hasInternet) {
      logInfo(`⚠️ Configured WiFi failed, staying on current WiFi with internet: ${currentWifi.ssid}`);
      this.recordSuccessfulConnection(currentWifi.ssid, 'current-fallback');
      return { success: true, connectedTo: 'current', ssid: currentWifi.ssid };
    }
    
    // Step 4: Try fallback WiFi
    logInfo('🔄 Step 2: Trying fallback WiFi...');
    const fallbackResult = await this.connectToFallbackWifi();
    
    if (fallbackResult.success) {
      const internetAfter = await this.testInternet();
      if (internetAfter) {
        logSuccess(`✅ Connected to fallback WiFi with internet: ${fallbackResult.ssid}`);
        return { success: true, connectedTo: 'fallback', ssid: fallbackResult.ssid };
      } else {
        logWarning(`⚠️ Connected to fallback WiFi but no internet: ${fallbackResult.ssid}`);
      }
    }
    
    // Step 5: If nothing worked, try to reconnect to any available WiFi
    logInfo('🔄 Step 3: Scanning for any available WiFi...');
    const networks = await this.scanNetworks(true);
    
    if (networks.length > 0) {
      // Try the strongest signal network (except configured one)
      const availableNetworks = networks
        .filter(n => n.ssid !== this.localWifiConfig.ssid)
        .sort((a, b) => b.signal - a.signal);
      
      if (availableNetworks.length > 0) {
        const strongestNetwork = availableNetworks[0];
        logInfo(`📶 Strongest available network: ${strongestNetwork.ssid} (${strongestNetwork.signal}%)`);
        
        // We can't connect without password, but we log it
        logInfo(`ℹ️ Would try ${strongestNetwork.ssid} but need password`);
      }
    }
    
    // Final fallback: Stay disconnected and keep retrying configured WiFi
    logInfo('🔄 Will retry configured WiFi in next cycle');
    return { 
      success: false, 
      error: 'All connection attempts failed',
      retryConfigured: true 
    };
  }

  // Enhanced WiFi connection method with multiple strategies
  async connectToWifiDirect(ssid, password, source = 'server') {
    try {
      logInfo(`🔗 Connecting to: ${ssid} (Source: ${source})`);
      
      if (!ssid || !password) {
        throw new Error('SSID and password are required');
      }

      // Try multiple connection methods
      const methods = [
        this.connectMethodDirect.bind(this, ssid, password),
        this.connectMethodHidden.bind(this, ssid, password),
        this.connectMethodProfile.bind(this, ssid, password)
      ];
      
      for (let i = 0; i < methods.length; i++) {
        try {
          logInfo(`🔗 Method ${i + 1}/${methods.length} for ${ssid}`);
          const result = await methods[i]();
          
          if (result.success) {
            // Verify connection
            await new Promise(resolve => setTimeout(resolve, 5000));
            const verifyWifi = await this.getCurrentWifiLinux();
            
            if (verifyWifi.ssid === ssid) {
              this.currentWifiSsid = ssid;
              this.connectionAttempts = 0;
              
              logSuccess(`✅ Connected to ${ssid} using method ${i + 1}`);
              return {
                success: true,
                ssid: ssid,
                source: source,
                method: i + 1,
                message: `Connected to ${ssid}`
              };
            } else {
              logWarning(`⚠️ Method ${i + 1} verification failed. Current: ${verifyWifi.ssid || 'None'}`);
            }
          }
        } catch (error) {
          logWarning(`Method ${i + 1} failed: ${error.message}`);
          continue;
        }
      }
      
      throw new Error('All connection methods failed');
      
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

  // Connection method 1: Direct connection
  async connectMethodDirect(ssid, password) {
    const escapedSsid = this.escapeSsid(ssid);
    const { stdout, stderr } = await this.executeCommand(
      `nmcli device wifi connect ${escapedSsid} password "${password}"`,
      30000
    );
    
    if (stderr && stderr.includes('No network with SSID')) {
      throw new Error('Network not found');
    }
    
    return { success: !stderr || stdout.includes('successfully activated') };
  }

  // Connection method 2: Hidden network
  async connectMethodHidden(ssid, password) {
    const escapedSsid = this.escapeSsid(ssid);
    const { stdout, stderr } = await this.executeCommand(
      `nmcli device wifi connect ${escapedSsid} password "${password}" hidden yes`,
      30000
    );
    
    return { success: !stderr || stdout.includes('successfully activated') };
  }

  // Connection method 3: Create profile
  async connectMethodProfile(ssid, password) {
    // Clean up first
    await this.executeCommand(`nmcli connection delete "${ssid}" 2>/dev/null || true`);
    
    // Create connection
    await this.executeCommand(`nmcli connection add type wifi con-name "${ssid}" ssid "${ssid}"`);
    await this.executeCommand(`nmcli connection modify "${ssid}" wifi-sec.key-mgmt wpa-psk`);
    await this.executeCommand(`nmcli connection modify "${ssid}" wifi-sec.psk "${password}"`);
    
    // Activate
    const { stdout, stderr } = await this.executeCommand(`nmcli connection up "${ssid}"`, 30000);
    
    return { success: !stderr || stdout.includes('successfully activated') };
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
      const { stdout } = await this.executeCommand('nmcli -t -f active,ssid dev wifi | grep yes: | cut -d: -f2');
      const ssid = stdout.trim();
      
      if (ssid && ssid !== '--') {
        const signal = await this.getWifiSignal(ssid);
        
        return {
          connected: true,
          ssid: ssid,
          signal: signal,
          ipAddress: await this.getIpAddress(),
          state: 'connected',
          source: ssid === this.localWifiConfig.ssid ? 'configured' : 'other'
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
        const { stdout } = await this.executeCommand("hostname -I | awk '{print $1}'");
        return stdout.trim();
      } else if (this.isMacOS) {
        const { stdout } = await this.executeCommand("ipconfig getifaddr en0");
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
        const { stdout } = await this.executeCommand(`nmcli -t -f ssid,signal dev wifi | grep "${ssid}:" | cut -d: -f2`);
        return parseInt(stdout.trim()) || 0;
      } else {
        return 80;
      }
    } catch (error) {
      return 0;
    }
  }

  // Test internet connectivity
  async testInternet() {
    const testEndpoints = [
      'http://www.google.com',
      'http://www.cloudflare.com',
      'http://1.1.1.1'
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
      logInfo('🔄 Starting persistent WiFi control...');
      
      // Fetch server config first
      const serverConfig = await this.fetchWifiFromServer();
      
      if (serverConfig.success && serverConfig.hasConfig) {
        logInfo(`📡 Server WiFi config: ${serverConfig.ssid}`);
        
        // Save/update config
        this.saveWifiConfigToFile(serverConfig.ssid, serverConfig.password, 'server');
      }
      
      // Execute connection strategy
      const result = await this.executeWifiConnectionStrategy();
      
      // Get final status
      const finalWifi = await this.getCurrentWifi();
      const finalInternet = await this.testInternet();
      
      logInfo(`📊 WiFi Control Complete: Connected=${finalWifi.connected ? finalWifi.ssid : 'No'}, Internet=${finalInternet}`);
      
      // Reset connection attempts if successful
      if (finalWifi.connected && finalInternet) {
        this.connectionAttempts = 0;
      }
      
      return result;
      
    } catch (error) {
      logError('❌ WiFi control error:', error);
      this.connectionAttempts++;
      return { success: false, error: error.message };
    }
  }

  // Start WiFi monitoring
  startMonitoring() {
    if (this.isMonitoring) {
      logWarning('WiFi monitoring is already running');
      return;
    }

    this.isMonitoring = true;
    logInfo('🚀 Starting persistent WiFi monitoring');

    // Initial control after 3 seconds
    setTimeout(() => {
      this.controlWifi();
    }, 3000);

    // Monitor every 30 seconds for persistent retry
    this.monitorInterval = setInterval(() => {
      this.controlWifi();
    }, 30000);

    logSuccess('✅ Persistent WiFi monitoring started (checks every 30 seconds)');
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
      fallback_config: {
        ssid: this.fallbackWifiSsid,
        has_password: !!this.fallbackWifiPassword
      },
      connection_history: this.connectionHistory,
      policy: "Persistent server WiFi with fallback",
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
      policy: "persistent-retry",
      checkInterval: '30 seconds',
      permissions: 'sudo'
    };
  }
}

export const wifiManager = new WifiManager();