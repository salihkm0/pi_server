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
    this.useSudo = false;
    this.currentUser = process.env.USER || 'pi';
    this.lastNetworkScan = null;
    this.scanCacheDuration = 30000;
    this.scanCache = [];
    
    // Check if we need sudo
    this.detectPermissions();
    
    // Load local WiFi config (only from server)
    this.localWifiConfig = this.loadLocalWifiConfig();
  }

  // Detect if we need sudo permissions
  async detectPermissions() {
    try {
      // Try to run a simple nmcli command without sudo
      await execAsync('nmcli -v');
      logInfo('✅ Running with normal user permissions');
      this.useSudo = false;
    } catch (error) {
      if (error.message.includes('permission') || error.message.includes('Not authorized')) {
        logWarning('⚠️ Need sudo permissions for WiFi control');
        this.useSudo = true;
      }
    }
  }

  // Execute command with appropriate permissions
  async executeCommand(command, timeout = 10000) {
    try {
      const cmd = this.useSudo ? `sudo ${command}` : command;
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
        // First check if WiFi is enabled
        try {
          const { stdout: radioStatus } = await this.executeCommand('nmcli radio wifi');
          if (radioStatus.trim() !== 'enabled') {
            logInfo('📻 WiFi radio is off, turning it on...');
            await this.executeCommand('nmcli radio wifi on');
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        } catch (error) {
          logWarning(`⚠️ Could not check WiFi radio status: ${error.message}`);
        }
        
        // Scan for networks - use a more comprehensive command
        try {
          await this.executeCommand('nmcli device wifi rescan', 10000);
          await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error) {
          logWarning(`⚠️ Rescan failed: ${error.message}`);
        }
        
        // Get list of networks using the same command you used manually
        const { stdout } = await this.executeCommand('nmcli -t -f SSID dev wifi');
        const lines = stdout.trim().split('\n').filter(line => line);
        
        const networks = [];
        for (const line of lines) {
          const ssid = line.trim();
          if (ssid && ssid !== '--' && ssid !== 'SSID') {
            // Get signal strength for this network
            let signal = 0;
            try {
              const { stdout: signalStdout } = await this.executeCommand(`nmcli -t -f SSID,SIGNAL dev wifi | grep "${ssid}:" | cut -d: -f2`);
              signal = parseInt(signalStdout.trim()) || 0;
            } catch (error) {
              // If we can't get signal, continue anyway
            }
            
            networks.push({
              ssid: ssid,
              signal: signal,
              security: 'WPA2' // Default assumption
            });
          }
        }
        
        // Alternative: Try to get more detailed info
        if (networks.length === 0) {
          logInfo('Trying alternative scan method...');
          try {
            const { stdout: detailedOutput } = await this.executeCommand('nmcli -f SSID,SIGNAL,SECURITY dev wifi');
            const detailedLines = detailedOutput.trim().split('\n').slice(1); // Skip header
            
            for (const line of detailedLines) {
              const parts = line.trim().split(/\s{2,}/);
              if (parts.length >= 2 && parts[0] && parts[0] !== '--') {
                networks.push({
                  ssid: parts[0],
                  signal: parseInt(parts[1]) || 0,
                  security: parts[2] || 'unknown'
                });
              }
            }
          } catch (error) {
            logWarning(`Alternative scan failed: ${error.message}`);
          }
        }
        
        // Update cache
        this.scanCache = networks;
        this.lastNetworkScan = now;
        
        logInfo(`✅ Found ${networks.length} WiFi networks`);
        
        // Debug: List all found networks
        if (networks.length > 0) {
          logInfo('📶 Found networks:');
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
      // First try the regular scan
      const networks = await this.scanNetworks();
      if (networks.some(network => network.ssid === ssid)) {
        return true;
      }
      
      // If not found, try a direct nmcli query for this specific SSID
      logInfo(`🔍 Doing targeted scan for SSID: ${ssid}`);
      
      // Try to get info about this specific network
      try {
        const { stdout } = await this.executeCommand(`nmcli -t -f SSID dev wifi list | grep "${ssid}"`);
        if (stdout.trim().includes(ssid)) {
          return true;
        }
      } catch (error) {
        // Network not found in list
      }
      
      // Try another method: check all available BSSIDs
      try {
        const { stdout } = await this.executeCommand('nmcli -t -f BSSID,SSID dev wifi');
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          const [bssid, networkSsid] = line.split(':');
          if (networkSsid === ssid) {
            logInfo(`✅ Found network "${ssid}" with BSSID: ${bssid}`);
            return true;
          }
        }
      } catch (error) {
        logWarning(`Could not scan BSSIDs: ${error.message}`);
      }
      
      return false;
    } catch (error) {
      logError(`Error checking network availability for ${ssid}:`, error);
      return false;
    }
  }

  // Fetch and apply server WiFi with improved scanning
  async fetchAndApplyServerWifi() {
    try {
      logInfo('🔄 Fetching and applying server WiFi configuration...');
      
      // Step 1: Fetch from server
      const serverConfig = await this.fetchWifiFromServer();
      
      if (!serverConfig.success || !serverConfig.hasConfig) {
        logWarning('📡 No server WiFi configuration available');
        
        const currentWifi = await this.getCurrentWifi();
        if (currentWifi.connected) {
          logInfo(`⚠️ No server WiFi config, staying on current WiFi: ${currentWifi.ssid}`);
        }
        
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
      
      // Step 3: Get current WiFi status
      const currentWifi = await this.getCurrentWifi();
      const hasInternet = await this.testInternet();
      
      // If already connected to the right WiFi, just verify
      if (currentWifi.connected && currentWifi.ssid === serverConfig.ssid) {
        logInfo(`✅ Already connected to server WiFi: ${serverConfig.ssid}`);
        
        if (hasInternet) {
          logSuccess(`✅ Internet is working on server WiFi`);
          return {
            success: true,
            ssid: serverConfig.ssid,
            source: 'server',
            alreadyConnected: true,
            internet: true
          };
        } else {
          logWarning(`⚠️ Connected to server WiFi but no internet`);
          // Will try to reconnect below
        }
      }
      
      // Step 4: Check if target network is available (with better scanning)
      logInfo(`🔍 Checking if network "${serverConfig.ssid}" is available...`);
      
      // First, do a fresh scan
      await this.scanNetworks(true); // Force refresh
      
      // Check using multiple methods
      const isAvailable = await this.isNetworkAvailable(serverConfig.ssid);
      
      if (!isAvailable) {
        logError(`❌ WiFi network "${serverConfig.ssid}" not found after deep scan`);
        logInfo(`💡 Staying on current WiFi: ${currentWifi.ssid || 'None'}`);
        
        // List what networks ARE available
        const availableNetworks = await this.scanNetworks();
        if (availableNetworks.length > 0) {
          logInfo(`📶 Available networks: ${availableNetworks.map(n => n.ssid).join(', ')}`);
        }
        
        return {
          success: false,
          error: `WiFi network "${serverConfig.ssid}" not found`,
          hasConfig: true,
          stayingOnCurrent: true,
          currentSsid: currentWifi.ssid,
          availableNetworks: availableNetworks.map(n => n.ssid)
        };
      }
      
      logInfo(`✅ Target network found: ${serverConfig.ssid}`);
      
      // Step 5: If currently connected to a different WiFi, try to disconnect
      if (currentWifi.connected && currentWifi.ssid !== serverConfig.ssid) {
        logInfo(`Disconnecting from current WiFi: ${currentWifi.ssid}`);
        const disconnectResult = await this.disconnectWifi();
        
        if (disconnectResult.success) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        } else {
          logWarning(`⚠️ Could not disconnect from ${currentWifi.ssid}, will try to connect anyway`);
        }
      }
      
      // Step 6: Connect to server WiFi with retry logic
      logInfo(`🔗 Attempting to connect to: ${serverConfig.ssid}`);
      
      let connectResult;
      let retryCount = 0;
      const maxRetries = 2;
      
      while (retryCount <= maxRetries) {
        if (retryCount > 0) {
          logInfo(`🔄 Retry ${retryCount}/${maxRetries} for ${serverConfig.ssid}`);
          await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
        }
        
        connectResult = await this.connectToWifiDirect(
          serverConfig.ssid,
          serverConfig.password,
          `server${retryCount > 0 ? '-retry' + retryCount : ''}`
        );
        
        if (connectResult.success) {
          break;
        }
        
        retryCount++;
      }
      
      if (connectResult.success) {
        logSuccess(`✅ Connected to server WiFi: ${serverConfig.ssid}`);
        
        // Verify internet after connection
        await new Promise(resolve => setTimeout(resolve, 5000));
        const newInternetStatus = await this.testInternet();
        
        return {
          success: true,
          ssid: serverConfig.ssid,
          source: 'server',
          internet: newInternetStatus,
          message: newInternetStatus ? 'Connected with internet' : 'Connected but no internet'
        };
      } else {
        logError(`❌ Failed to connect to server WiFi after ${maxRetries + 1} attempts: ${connectResult.error}`);
        
        // If we disconnected but couldn't connect, try to go back to original
        if (currentWifi.connected && currentWifi.ssid !== serverConfig.ssid) {
          logWarning(`⚠️ Disconnected from ${currentWifi.ssid} but couldn't connect to ${serverConfig.ssid}`);
          // Note: We can't reconnect without password
        }
        
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

  // Enhanced WiFi connection method
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

  // Improved Linux WiFi connection
  async connectToWifiLinux(ssid, password) {
    try {
      logInfo(`📶 Attempting to connect to "${ssid}"...`);
      
      // Check if NetworkManager is available
      try {
        await this.executeCommand('which nmcli');
      } catch (error) {
        throw new Error('NetworkManager (nmcli) is not available');
      }

      // Ensure WiFi is enabled
      try {
        await this.executeCommand('nmcli radio wifi on');
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        logWarning(`⚠️ Could not enable WiFi radio: ${error.message}`);
      }

      // Check if we're already connected to this network
      const currentWifi = await this.getCurrentWifiLinux();
      if (currentWifi.ssid === ssid) {
        logInfo(`✅ Already connected to ${ssid}`);
        return { success: true, ssid };
      }

      // Delete existing connection if it exists (clean start)
      try {
        await this.executeCommand(`nmcli connection delete "${ssid}" 2>/dev/null || true`);
        logInfo(`Cleaned up existing connection for: ${ssid}`);
      } catch (error) {
        // Ignore errors
      }

      // First, try the standard connection method
      logInfo(`🔗 Method 1: Standard nmcli connect...`);
      const escapedSsid = this.escapeSsid(ssid);
      
      try {
        const { stdout, stderr } = await this.executeCommand(
          `nmcli device wifi connect ${escapedSsid} password "${password}"`,
          30000
        );

        if (stderr) {
          logWarning(`⚠️ Method 1 stderr: ${stderr}`);
          
          if (stderr.includes('No network with SSID')) {
            // Network might be hidden or not broadcasting SSID
            logInfo(`🔄 Network "${ssid}" not found, trying alternative methods...`);
            
            // Method 2: Try with hidden network flag
            logInfo(`🔗 Method 2: Trying as hidden network...`);
            try {
              const { stdout: stdout2, stderr: stderr2 } = await this.executeCommand(
                `nmcli device wifi connect ${escapedSsid} password "${password}" hidden yes`,
                30000
              );
              
              if (!stderr2 || stdout2.includes('successfully activated')) {
                logSuccess(`✅ Connected to hidden network: ${ssid}`);
              } else {
                throw new Error(`Hidden network connect failed: ${stderr2}`);
              }
            } catch (error2) {
              logWarning(`Method 2 failed: ${error2.message}`);
              
              // Method 3: Create connection profile first
              logInfo(`🔗 Method 3: Creating connection profile...`);
              try {
                // Create connection
                await this.executeCommand(`nmcli connection add type wifi con-name "${ssid}" ssid "${ssid}"`);
                await this.executeCommand(`nmcli connection modify "${ssid}" wifi-sec.key-mgmt wpa-psk`);
                await this.executeCommand(`nmcli connection modify "${ssid}" wifi-sec.psk "${password}"`);
                
                // Activate connection
                await this.executeCommand(`nmcli connection up "${ssid}"`);
                
                logSuccess(`✅ Connected via profile: ${ssid}`);
              } catch (error3) {
                logError(`Method 3 failed: ${error3.message}`);
                throw new Error(`All connection methods failed for "${ssid}"`);
              }
            }
          } else if (stderr.includes('Secrets were required')) {
            throw new Error('Wrong WiFi password');
          } else if (stderr.includes('already exists')) {
            // Try to activate existing connection
            await this.executeCommand(`nmcli connection up "${ssid}"`);
          } else {
            // Some other error, check stdout for success message
            if (!stdout.includes('successfully activated')) {
              throw new Error(stderr || 'Connection failed');
            }
          }
        } else if (stdout.includes('successfully activated')) {
          logSuccess(`✅ Standard connection successful: ${ssid}`);
        }
      } catch (error) {
        throw new Error(`Connection failed: ${error.message}`);
      }

      // Wait for connection to stabilize
      await new Promise(resolve => setTimeout(resolve, 8000));

      // Verify connection
      const verifyWifi = await this.getCurrentWifiLinux();
      if (verifyWifi.ssid === ssid) {
        logSuccess(`✅ Verified connection to: ${ssid} (signal: ${verifyWifi.signal}%)`);
        return { success: true, ssid };
      } else {
        throw new Error(`Connected but verification failed. Current: ${verifyWifi.ssid || 'None'}`);
      }

    } catch (error) {
      throw new Error(`Linux connection failed: ${error.message}`);
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
      // Try multiple methods to get current WiFi
      let ssid = null;
      
      // Method 1: Check active connection
      try {
        const { stdout } = await this.executeCommand('nmcli -t -f active,ssid dev wifi | grep yes: | cut -d: -f2');
        ssid = stdout.trim();
      } catch (error) {
        // Method 2: Check general status
        try {
          const { stdout } = await this.executeCommand('nmcli -t -f GENERAL.CONNECTION dev show wlan0 | cut -d: -f2');
          ssid = stdout.trim();
        } catch (error2) {
          // Method 3: Check connection state
          try {
            const { stdout } = await this.executeCommand('nmcli -t -f NAME,TYPE connection show --active | grep wifi | cut -d: -f1');
            ssid = stdout.trim();
          } catch (error3) {
            // All methods failed
          }
        }
      }
      
      if (ssid && ssid !== '--') {
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

  // Disconnect from WiFi
  async disconnectWifi() {
    try {
      const currentWifi = await this.getCurrentWifi();
      
      if (currentWifi.connected) {
        logInfo(`Disconnecting from WiFi: ${currentWifi.ssid}`);
        
        if (this.isLinux) {
          // Try multiple methods
          try {
            await this.executeCommand(`nmcli connection down id "${currentWifi.ssid}"`);
          } catch (error) {
            logWarning(`First disconnect method failed: ${error.message}`);
            try {
              await this.executeCommand(`nmcli device disconnect wlan0`);
            } catch (error2) {
              logWarning(`Second disconnect method failed: ${error2.message}`);
              try {
                await this.executeCommand(`nmcli radio wifi off`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                await this.executeCommand(`nmcli radio wifi on`);
              } catch (error3) {
                logWarning(`Radio toggle failed: ${error3.message}`);
              }
            }
          }
        }
        
        // Verify disconnection
        await new Promise(resolve => setTimeout(resolve, 3000));
        const verifyWifi = await this.getCurrentWifi();
        
        if (!verifyWifi.connected) {
          logSuccess(`✅ Disconnected from WiFi: ${currentWifi.ssid}`);
          this.currentWifiSsid = null;
          
          return {
            success: true,
            message: `Disconnected from ${currentWifi.ssid}`,
            ssid: currentWifi.ssid
          };
        } else {
          logWarning(`⚠️ Still connected to ${verifyWifi.ssid}`);
          return {
            success: false,
            message: `Could not disconnect from ${currentWifi.ssid}`,
            ssid: currentWifi.ssid
          };
        }
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
      logInfo('🔄 Starting server-only WiFi control...');
      
      // Get current status
      const currentWifi = await this.getCurrentWifi();
      const hasInternet = await this.testInternet();
      
      logInfo(`📊 Current: WiFi=${currentWifi.ssid || 'None'}, Internet=${hasInternet}`);
      
      // Fetch server config
      const serverConfig = await this.fetchWifiFromServer();
      
      if (serverConfig.success && serverConfig.hasConfig) {
        logInfo(`📡 Server WiFi config: ${serverConfig.ssid}`);
        
        // Check if we're already connected to the right WiFi
        if (currentWifi.ssid === serverConfig.ssid) {
          logInfo(`✅ Already connected to server WiFi: ${serverConfig.ssid}`);
          
          if (!hasInternet) {
            logWarning(`⚠️ Connected but no internet, will try to reconnect...`);
            // Try to reconnect
            const reconnectResult = await this.fetchAndApplyServerWifi();
            if (reconnectResult.success) {
              logSuccess(`✅ Reconnected successfully`);
            }
          } else {
            // Everything is good, just save config
            this.saveWifiConfigToFile(serverConfig.ssid, serverConfig.password, 'server');
          }
          return;
        }
        
        // Not connected to server WiFi - try to connect
        logInfo(`🔄 Server wants us on WiFi: ${serverConfig.ssid}`);
        
        // Save config first
        this.saveWifiConfigToFile(serverConfig.ssid, serverConfig.password, 'server');
        
        // Try to connect to server WiFi
        const result = await this.fetchAndApplyServerWifi();
        
        if (result.success) {
          logSuccess(`✅ Successfully connected to server WiFi: ${serverConfig.ssid}`);
        } else if (result.stayingOnCurrent) {
          logInfo(`⚠️ Staying on current WiFi: ${result.currentSsid} (server WiFi not available)`);
        } else {
          logError(`❌ Failed to connect to server WiFi: ${result.error}`);
        }
      } else if (serverConfig.success && !serverConfig.hasConfig) {
        // No server WiFi configured
        logWarning('📡 No server WiFi configuration');
        
        // Don't disconnect if no server config - stay on current WiFi
        if (currentWifi.connected) {
          logInfo(`⚠️ No server WiFi config, staying on current WiFi: ${currentWifi.ssid}`);
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

    // Monitor every 60 seconds
    this.monitorInterval = setInterval(() => {
      this.controlWifi();
    }, 60000);

    logSuccess('✅ Server-only WiFi monitoring started (checks every 60 seconds)');
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
      checkInterval: '60 seconds',
      permissions: this.useSudo ? 'sudo' : 'normal'
    };
  }
}

export const wifiManager = new WifiManager();