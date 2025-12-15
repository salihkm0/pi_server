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

class WifiManager {
  constructor() {
    this.isMonitoring = false;
    this.monitorInterval = null;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 5;
    this.currentWifiSsid = null;
    this.serverWifiConfigured = false;
    this.lastServerCheck = null;
    this.lastServerConfig = null;
    this.isLinux = process.platform === 'linux';
    this.isMacOS = process.platform === 'darwin';
    
    // Load local WiFi config (only from server)
    this.localWifiConfig = this.loadLocalWifiConfig();
    
    logInfo(`🔧 WiFi Manager initialized. Current config: ${JSON.stringify(this.localWifiConfig)}`);
  }

  // Execute command with sudo
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

  // Load local WiFi configuration (NO ENCRYPTION)
  loadLocalWifiConfig() {
    try {
      if (fs.existsSync(LOCAL_WIFI_PATH)) {
        const data = JSON.parse(fs.readFileSync(LOCAL_WIFI_PATH, 'utf8'));
        
        logInfo(`📋 Loaded WiFi config from file: ${JSON.stringify(data)}`);
        
        // Check if it's a server config
        if (data.source === 'server') {
          // NO DECRYPTION - plain text password
          const password = data.password || data.wifi_password || '';
          
          logSuccess(`✅ Loaded server WiFi config: ${data.ssid}`);
          return {
            ssid: data.ssid,
            password: password,
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

  // Save WiFi configuration to file (NO ENCRYPTION)
  saveWifiConfigToFile(ssid, password, source = 'server') {
    try {
      // Only allow server configs
      if (source !== 'server') {
        logError(`❌ Rejected WiFi config from ${source} - only server configs allowed`);
        return false;
      }

      const configToSave = {
        ssid: ssid,
        password: password, // PLAIN TEXT - NO ENCRYPTION
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
      logInfo(`🔐 Password stored (plain text): ${password}`);
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

  // Scan for available WiFi networks
  async scanNetworks() {
    try {
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
        
        // Get list of networks using iwlist (more reliable)
        const { stdout } = await this.executeCommand('sudo iwlist wlan0 scan | grep ESSID');
        const lines = stdout.trim().split('\n').filter(line => line);
        
        const networks = [];
        for (const line of lines) {
          const match = line.match(/ESSID:"([^"]+)"/);
          if (match && match[1]) {
            networks.push({
              ssid: match[1],
              signal: 0 // iwlist doesn't show signal in this output
            });
          }
        }
        
        logInfo(`✅ Found ${networks.length} WiFi networks using iwlist`);
        
        // Also get nmcli list for signal strength
        try {
          const { stdout: nmcliStdout } = await this.executeCommand('nmcli -t -f SSID,SIGNAL dev wifi');
          const nmcliLines = nmcliStdout.trim().split('\n').filter(line => line);
          
          for (const line of nmcliLines) {
            const [ssid, signalStr] = line.split(':');
            if (ssid && ssid !== '--') {
              const existingNetwork = networks.find(n => n.ssid === ssid);
              if (existingNetwork) {
                existingNetwork.signal = parseInt(signalStr) || 0;
              } else {
                networks.push({
                  ssid: ssid,
                  signal: parseInt(signalStr) || 0
                });
              }
            }
          }
        } catch (error) {
          logWarning(`Could not get signal strength: ${error.message}`);
        }
        
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

  // Check if network is available
  async isNetworkAvailable(ssid) {
    try {
      const networks = await this.scanNetworks();
      const found = networks.some(network => network.ssid === ssid);
      
      if (found) {
        logInfo(`✅ Network "${ssid}" is available`);
        return true;
      } else {
        logInfo(`❌ Network "${ssid}" not found in scan`);
        logInfo(`📶 Available: ${networks.map(n => n.ssid).join(', ') || 'None'}`);
        return false;
      }
    } catch (error) {
      logError(`Error checking network availability for ${ssid}:`, error);
      return false;
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

  // Get current WiFi connection
  async getCurrentWifi() {
    try {
      if (this.isLinux) {
        // Method 1: Use iw command (more reliable)
        try {
          const { stdout } = await this.executeCommand('iw wlan0 link | grep SSID');
          const match = stdout.match(/SSID: (.+)/);
          if (match && match[1]) {
            const ssid = match[1].trim();
            return {
              connected: true,
              ssid: ssid,
              signal: await this.getWifiSignal(ssid),
              ipAddress: await this.getIpAddress(),
              state: 'connected',
              source: ssid === this.localWifiConfig.ssid ? 'configured' : 'other'
            };
          }
        } catch (error) {
          // Method 2: Use nmcli
          try {
            const { stdout } = await this.executeCommand('nmcli -t -f active,ssid dev wifi | grep yes: | cut -d: -f2');
            const ssid = stdout.trim();
            
            if (ssid && ssid !== '--') {
              return {
                connected: true,
                ssid: ssid,
                signal: await this.getWifiSignal(ssid),
                ipAddress: await this.getIpAddress(),
                state: 'connected',
                source: ssid === this.localWifiConfig.ssid ? 'configured' : 'other'
              };
            }
          } catch (error2) {
            // Not connected
          }
        }
        
        return {
          connected: false,
          ssid: null,
          signal: 0,
          state: 'disconnected',
          source: 'none'
        };
      }
      
      return {
        connected: false,
        ssid: null,
        error: `Unsupported platform: ${process.platform}`
      };
    } catch (error) {
      logError('Error getting current WiFi:', error);
      return {
        connected: false,
        ssid: null,
        error: error.message
      };
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

  // Disconnect from current WiFi
  async disconnectWifi() {
    try {
      const currentWifi = await this.getCurrentWifi();
      
      if (currentWifi.connected) {
        logInfo(`Disconnecting from WiFi: ${currentWifi.ssid}`);
        
        if (this.isLinux) {
          await this.executeCommand(`nmcli connection down "${currentWifi.ssid}"`);
        }
        
        // Verify disconnection
        await new Promise(resolve => setTimeout(resolve, 3000));
        const verifyWifi = await this.getCurrentWifi();
        
        if (!verifyWifi.connected) {
          logSuccess(`✅ Disconnected from WiFi: ${currentWifi.ssid}`);
          this.currentWifiSsid = null;
          return { success: true, message: `Disconnected from ${currentWifi.ssid}` };
        } else {
          logWarning(`⚠️ Still connected to ${verifyWifi.ssid}`);
          return { success: false, message: `Could not disconnect from ${currentWifi.ssid}` };
        }
      } else {
        return { success: true, message: 'Not connected to any WiFi' };
      }
    } catch (error) {
      logError('Error disconnecting WiFi:', error);
      return { success: false, error: error.message };
    }
  }

  // Connect to WiFi with detailed debugging
  async connectToWifi(ssid, password) {
    try {
      logInfo(`🔗 Attempting to connect to: ${ssid}`);
      logInfo(`🔐 Using password: ${password}`);
      
      if (!ssid || !password) {
        throw new Error('SSID and password are required');
      }

      // Check if already connected
      const currentWifi = await this.getCurrentWifi();
      if (currentWifi.connected && currentWifi.ssid === ssid) {
        logInfo(`✅ Already connected to ${ssid}`);
        return { success: true, ssid: ssid, alreadyConnected: true };
      }

      // Ensure WiFi is on
      await this.executeCommand('nmcli radio wifi on');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Delete existing connection if it exists
      try {
        await this.executeCommand(`nmcli connection delete "${ssid}" 2>/dev/null || true`);
        logInfo(`Deleted existing connection for: ${ssid}`);
      } catch (error) {
        // Ignore errors
      }

      // Try different connection methods
      const methods = [
        // Method 1: Standard nmcli
        async () => {
          logInfo('🔗 Method 1: Standard nmcli connect');
          const escapedSsid = this.escapeSsid(ssid);
          const { stdout, stderr } = await this.executeCommand(
            `nmcli device wifi connect ${escapedSsid} password "${password}"`,
            30000
          );
          return { stdout, stderr, method: 1 };
        },
        
        // Method 2: With hidden flag
        async () => {
          logInfo('🔗 Method 2: With hidden flag');
          const escapedSsid = this.escapeSsid(ssid);
          const { stdout, stderr } = await this.executeCommand(
            `nmcli device wifi connect ${escapedSsid} password "${password}" hidden yes`,
            30000
          );
          return { stdout, stderr, method: 2 };
        },
        
        // Method 3: Create connection profile
        async () => {
          logInfo('🔗 Method 3: Create connection profile');
          try {
            // Create connection
            await this.executeCommand(`nmcli connection add type wifi con-name "${ssid}" ssid "${ssid}"`);
            await this.executeCommand(`nmcli connection modify "${ssid}" wifi-sec.key-mgmt wpa-psk`);
            await this.executeCommand(`nmcli connection modify "${ssid}" wifi-sec.psk "${password}"`);
            
            // Activate
            const { stdout, stderr } = await this.executeCommand(`nmcli connection up "${ssid}"`, 30000);
            return { stdout, stderr, method: 3 };
          } catch (error) {
            return { stdout: '', stderr: error.message, method: 3 };
          }
        },
        
        // Method 4: Use wpa_supplicant (last resort)
        async () => {
          logInfo('🔗 Method 4: Manual wpa_supplicant');
          try {
            // Create wpa_supplicant config
            const wpaConfig = `
network={
  ssid="${ssid}"
  psk="${password}"
}
`;
            
            const configPath = '/tmp/wpa_supplicant.conf';
            fs.writeFileSync(configPath, wpaConfig);
            
            // Stop wpa_supplicant if running
            await this.executeCommand('killall wpa_supplicant 2>/dev/null || true');
            
            // Start with new config
            const { stdout, stderr } = await this.executeCommand(
              `wpa_supplicant -B -i wlan0 -c ${configPath}`,
              20000
            );
            
            // Get IP via dhclient
            await this.executeCommand('dhclient wlan0', 10000);
            
            return { stdout, stderr, method: 4 };
          } catch (error) {
            return { stdout: '', stderr: error.message, method: 4 };
          }
        }
      ];

      // Try each method
      for (const method of methods) {
        try {
          const { stdout, stderr, method: methodNum } = await method();
          
          logInfo(`📋 Method ${methodNum} output: ${stdout.substring(0, 200)}...`);
          if (stderr) logInfo(`⚠️ Method ${methodNum} stderr: ${stderr.substring(0, 200)}...`);
          
          // Wait for connection
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // Check if connected
          const checkWifi = await this.getCurrentWifi();
          if (checkWifi.connected && checkWifi.ssid === ssid) {
            logSuccess(`✅ Connected to ${ssid} using method ${methodNum}`);
            this.currentWifiSsid = ssid;
            this.connectionAttempts = 0;
            
            // Test internet
            const hasInternet = await this.testInternet();
            
            return {
              success: true,
              ssid: ssid,
              method: methodNum,
              internet: hasInternet,
              message: `Connected to ${ssid}${hasInternet ? ' with internet' : ' but no internet'}`
            };
          }
        } catch (error) {
          logWarning(`Method failed: ${error.message}`);
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
        logInfo(`🔐 Server WiFi password: ${wifi_password}`);
        
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

  // Connect to configured WiFi
  async connectToConfiguredWifi() {
    const config = this.loadLocalWifiConfig();
    
    if (!config.ssid || !config.password) {
      logError('❌ No configured WiFi found in local file');
      return { success: false, error: 'No configured WiFi' };
    }
    
    logInfo(`🔗 Connecting to configured WiFi: ${config.ssid}`);
    logInfo(`🔐 Password from file: ${config.password}`);
    
    // Check if network is available
    const isAvailable = await this.isNetworkAvailable(config.ssid);
    
    if (!isAvailable) {
      logWarning(`⚠️ Configured WiFi "${config.ssid}" not available`);
      return { 
        success: false, 
        error: `Network "${config.ssid}" not available`
      };
    }
    
    // Try to connect
    return await this.connectToWifi(config.ssid, config.password);
  }

  // Main WiFi control logic
  async controlWifi() {
    try {
      logInfo('🔄 Starting WiFi control...');
      
      // Get current status
      const currentWifi = await this.getCurrentWifi();
      const hasInternet = await this.testInternet();
      
      logInfo(`📊 Current: WiFi=${currentWifi.ssid || 'None'}, Internet=${hasInternet}`);
      
      // Fetch server config
      const serverConfig = await this.fetchWifiFromServer();
      
      if (serverConfig.success && serverConfig.hasConfig) {
        logInfo(`📡 Server wants us on WiFi: ${serverConfig.ssid}`);
        
        // Save/update config
        this.saveWifiConfigToFile(serverConfig.ssid, serverConfig.password, 'server');
        
        // Check if we're already connected to the right WiFi
        if (currentWifi.connected && currentWifi.ssid === serverConfig.ssid) {
          logInfo(`✅ Already connected to server WiFi: ${serverConfig.ssid}`);
          
          if (!hasInternet) {
            logWarning(`⚠️ Connected but no internet, will try to reconnect...`);
            // Continue to reconnect logic
          } else {
            logSuccess(`✅ Perfect! Connected to server WiFi with internet`);
            return { success: true, connectedTo: 'server', ssid: serverConfig.ssid };
          }
        }
        
        // Not connected to server WiFi - try to connect
        logInfo(`🔄 Attempting to connect to server WiFi: ${serverConfig.ssid}`);
        const connectResult = await this.connectToWifi(serverConfig.ssid, serverConfig.password);
        
        if (connectResult.success) {
          logSuccess(`✅ Connected to server WiFi: ${serverConfig.ssid}`);
          return connectResult;
        } else {
          logError(`❌ Failed to connect to server WiFi: ${connectResult.error}`);
          
          // If we have internet from current WiFi, stay connected
          if (currentWifi.connected && hasInternet) {
            logInfo(`⚠️ Server WiFi failed, staying on current WiFi with internet: ${currentWifi.ssid}`);
            return { success: true, connectedTo: 'current', ssid: currentWifi.ssid };
          }
        }
      } else if (serverConfig.success && !serverConfig.hasConfig) {
        // No server WiFi configured
        logWarning('📡 No server WiFi configuration');
        
        // Try configured WiFi from file
        const config = this.loadLocalWifiConfig();
        if (config.ssid) {
          logInfo(`🔄 Trying configured WiFi from file: ${config.ssid}`);
          const connectResult = await this.connectToConfiguredWifi();
          
          if (connectResult.success) {
            return connectResult;
          }
        }
        
        // Stay on current WiFi if it has internet
        if (currentWifi.connected && hasInternet) {
          logInfo(`⚠️ No server config, staying on current WiFi: ${currentWifi.ssid}`);
          return { success: true, connectedTo: 'current', ssid: currentWifi.ssid };
        }
      }
      
      // If nothing else worked, try configured WiFi from file
      const config = this.loadLocalWifiConfig();
      if (config.ssid && config.password) {
        logInfo(`🔄 Last resort: Trying configured WiFi from file: ${config.ssid}`);
        const connectResult = await this.connectToConfiguredWifi();
        
        if (connectResult.success) {
          return connectResult;
        }
      }
      
      // Get final status
      const finalWifi = await this.getCurrentWifi();
      const finalInternet = await this.testInternet();
      
      logInfo(`📊 WiFi Control Complete: Connected=${finalWifi.connected ? finalWifi.ssid : 'No'}, Internet=${finalInternet}`);
      
      if (finalWifi.connected && finalInternet) {
        this.connectionAttempts = 0;
        return { success: true, connectedTo: 'final', ssid: finalWifi.ssid };
      }
      
      return { success: false, error: 'All connection attempts failed' };
      
    } catch (error) {
      logError('❌ WiFi control error:', error);
      this.connectionAttempts++;
      return { success: false, error: error.message };
    }
  }

  // Manual connection endpoint
  async manualConnect(ssid, password) {
    try {
      logInfo(`🔧 Manual connection requested for: ${ssid}`);
      
      // Save to file
      this.saveWifiConfigToFile(ssid, password, 'manual');
      
      // Connect
      const result = await this.connectToWifi(ssid, password);
      
      if (result.success) {
        logSuccess(`✅ Manual connection successful: ${ssid}`);
      } else {
        logError(`❌ Manual connection failed: ${result.error}`);
      }
      
      return result;
    } catch (error) {
      logError('Manual connection error:', error);
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
    logInfo('🚀 Starting WiFi monitoring');

    // Initial control after 3 seconds
    setTimeout(() => {
      this.controlWifi();
    }, 3000);

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

  // Get WiFi status for API
  async getWifiStatus() {
    const currentWifi = await this.getCurrentWifi();
    const hasInternet = await this.testInternet();
    const serverConfig = this.lastServerConfig;
    const localConfig = this.loadLocalWifiConfig();
    
    // Scan networks to show what's available
    const availableNetworks = await this.scanNetworks();
    
    return {
      current_wifi: currentWifi,
      internet: hasInternet,
      server_config: serverConfig,
      local_config: {
        ssid: localConfig.ssid,
        source: localConfig.source,
        last_updated: localConfig.last_updated,
        has_password: !!localConfig.password
      },
      available_networks: availableNetworks.map(n => n.ssid),
      connection_attempts: this.connectionAttempts,
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
      checkInterval: '30 seconds',
      permissions: 'sudo'
    };
  }
}

export const wifiManager = new WifiManager();