import express from "express";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import routes from "./routes/index.js";
import { hybridUpdateService } from "./services/updateService.js";
import { logWarning, logInfo, logError, logSuccess } from "./utils/logger.js";
import displayRouter from "./routes/displayRoutes.js";
import { registerDevice, updateDeviceStatus } from "./services/deviceRegistration.js";
import { startHealthMonitoring } from "./services/healthMonitor.js";
import { MQTTService } from "./services/mqttService.js";
import { configManager } from "./services/configManager.js";
import { getDeviceId, getSystemInfo, getRaspberryPiUsername } from "./utils/systemInfo.js";
import { syncService } from "./services/syncService.js";
import { initializeAndSync } from "./services/initializeAndSync.js";
import { wifiManager } from "./services/wifiManager.js";
import { isInternetConnected } from "./services/videoService.js";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// Auto-configure based on environment
export const SERVER_URL = process.env.SERVER_URL || `https://iot-ads-display.onrender.com`;
export const MQTT_BROKER = process.env.MQTT_BROKER || 'disabled';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const VIDEOS_DIR = path.join(__dirname, "./ads-videos");

// Auto-generate device configuration using Raspberry Pi username
export let RPI_ID = await getDeviceId();
export let RPI_USERNAME = await getRaspberryPiUsername();
export let deviceConfig = await configManager.loadConfig();

// Create MQTT service instance after RPI_ID is available (only if not disabled)
export const mqttService = MQTT_BROKER !== 'disabled' ? new MQTTService(RPI_ID) : null;

console.log("Device ID:", RPI_ID);
console.log("Raspberry Pi Username:", RPI_USERNAME);
console.log("MQTT Enabled:", MQTT_BROKER !== 'disabled');
console.log("Server Port:", process.env.PORT || 3000);
console.log("Central Server URL:", SERVER_URL);

app.use("/videos", express.static(VIDEOS_DIR));
app.use("/api", routes);
app.use("/api", displayRouter);

// Enhanced health check with WiFi status
app.get("/health", async (req, res) => {
  const systemInfo = await getSystemInfo();
  const wifiStatus = await wifiManager.getCurrentWifi();
  const internetStatus = await isInternetConnected();
  const monitoringStatus = wifiManager.getMonitoringStatus();
  const syncStatus = syncService.getStatus();
  
  res.json({
    status: "healthy",
    deviceId: RPI_ID,
    username: RPI_USERNAME,
    version: deviceConfig.version,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    system: systemInfo,
    mqttConnected: mqttService ? mqttService.connected : false,
    wifi: wifiStatus,
    internet: internetStatus,
    wifiMonitoring: monitoringStatus,
    sync: syncStatus,
    videos: {
      local: syncStatus.localVideos,
      partial: syncStatus.partialVideos
    }
  });
});

// WiFi management endpoints
app.post("/api/wifi/connect", async (req, res) => {
  try {
    const { ssid, password, storeCredentials = true } = req.body;
    
    if (!ssid || !password) {
      return res.status(400).json({ 
        success: false, 
        error: "SSID and password are required" 
      });
    }

    logInfo(`Attempting to connect to WiFi: ${ssid}`);
    const result = await wifiManager.connectToWifi(ssid, password, storeCredentials);
    
    if (result.success) {
      // Update central server with new WiFi info
      try {
        if (await isInternetConnected()) {
          await updateDeviceStatus("active");
        }
      } catch (error) {
        logWarning("Could not update central server with WiFi change");
      }
      
      res.json({ 
        success: true, 
        message: `Successfully connected to ${ssid}`,
        ssid: ssid
      });
    } else {
      res.status(400).json({ 
        success: false, 
        error: result.error,
        attempts: result.attempts
      });
    }
  } catch (error) {
    logError("WiFi connection error:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.get("/api/wifi/status", async (req, res) => {
  try {
    const wifiStatus = await wifiManager.getCurrentWifi();
    const availableNetworks = await wifiManager.scanNetworks();
    const monitoringStatus = wifiManager.getMonitoringStatus();
    const storedNetworks = wifiManager.getAllStoredNetworks();
    const defaultWifi = wifiManager.getDefaultWifi();
    
    res.json({
      success: true,
      current: wifiStatus,
      available: availableNetworks,
      monitoring: monitoringStatus,
      stored: storedNetworks,
      default: defaultWifi
    });
  } catch (error) {
    logError("WiFi status error:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.post("/api/wifi/disconnect", async (req, res) => {
  try {
    const result = await wifiManager.disconnectWifi();
    res.json({ 
      success: result.success, 
      message: result.message 
    });
  } catch (error) {
    logError("WiFi disconnect error:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.get("/api/wifi/networks", async (req, res) => {
  try {
    const storedNetworks = wifiManager.getAllStoredNetworks();
    const networksWithDetails = storedNetworks.map(ssid => {
      const credentials = wifiManager.getStoredWifiCredentials(ssid);
      return {
        ssid: ssid,
        stored: true,
        lastUsed: credentials?.timestamp
      };
    });
    
    res.json({
      success: true,
      networks: networksWithDetails
    });
  } catch (error) {
    logError("WiFi networks error:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.delete("/api/wifi/networks/:ssid", async (req, res) => {
  try {
    const { ssid } = req.params;
    await wifiManager.removeStoredCredentials(ssid);
    
    res.json({
      success: true,
      message: `Removed WiFi network: ${ssid}`
    });
  } catch (error) {
    logError("WiFi network removal error:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Fetch WiFi configuration from central server
app.get("/api/wifi/fetch-config", async (req, res) => {
  try {
    logInfo("Fetching WiFi configuration from central server...");
    
    const axios = await import('axios');
    const response = await axios.default.get(`${SERVER_URL}/api/wifi-config/${RPI_ID}`, {
      timeout: 15000,
      headers: {
        'User-Agent': `ADS-Display/${RPI_ID}`,
        'Accept': 'application/json'
      }
    });

    if (response.data.success && response.data.has_wifi_config) {
      const { wifi_ssid, wifi_password } = response.data;
      
      logInfo(`Received WiFi configuration from central server: ${wifi_ssid}`);
      
      // Connect using the received configuration
      const connectResult = await wifiManager.connectToWifi(wifi_ssid, wifi_password, true);
      
      if (connectResult.success) {
        res.json({
          success: true,
          message: `Successfully connected to configured WiFi: ${wifi_ssid}`,
          ssid: wifi_ssid
        });
      } else {
        res.status(400).json({
          success: false,
          message: `Failed to connect to configured WiFi: ${connectResult.error}`,
          ssid: wifi_ssid
        });
      }
    } else {
      res.status(404).json({
        success: false,
        message: "No WiFi configuration found on central server"
      });
    }
  } catch (error) {
    logError("Failed to fetch WiFi configuration:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch WiFi configuration from central server",
      error: error.message
    });
  }
});

// Update endpoints
app.post("/api/update", async (req, res) => {
  try {
    logInfo("Manual update triggered via API");
    const result = await hybridUpdateService.autoUpdate();
    res.json({ 
      success: result, 
      message: result ? "Update completed" : "Update failed" 
    });
  } catch (error) {
    logError("API update error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/version", (req, res) => {
  res.json({
    deviceId: RPI_ID,
    username: RPI_USERNAME,
    currentVersion: deviceConfig.version,
    updateAvailable: hybridUpdateService.updateAvailable,
    lastChecked: hybridUpdateService.lastChecked,
    mqttEnabled: MQTT_BROKER !== 'disabled',
    wifiMonitoring: wifiManager.getMonitoringStatus()
  });
});

// Sync endpoint
app.post("/api/sync", async (req, res) => {
  try {
    logInfo("Manual sync triggered via API");
    const result = await syncService.syncVideos();
    res.json({
      success: result.success,
      message: result.message,
      ...result
    });
  } catch (error) {
    logError("API sync error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Status update endpoint - for central server to check status
app.post("/api/status", async (req, res) => {
  try {
    const systemInfo = await getSystemInfo();
    const wifiStatus = await wifiManager.getCurrentWifi();
    const internetStatus = await isInternetConnected();
    const syncStatus = syncService.getStatus();
    
    const statusData = {
      deviceId: RPI_ID,
      rpi_name: RPI_USERNAME,
      status: "active",
      timestamp: new Date().toISOString(),
      system: systemInfo,
      version: deviceConfig.version,
      uptime: process.uptime(),
      mqttConnected: mqttService ? mqttService.connected : false,
      videosCount: syncStatus.localVideos,
      wifi: wifiStatus,
      internet: internetStatus,
      wifi_ssid: wifiStatus.connected ? wifiStatus.ssid : null
    };
    
    // Also update central server (if internet is available)
    if (internetStatus) {
      await updateDeviceStatus("active", systemInfo);
    }
    
    res.json({
      success: true,
      message: "Status updated",
      data: statusData
    });
  } catch (error) {
    logError("Status update error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Initialize application with WiFi auto-connection
const initApp = async () => {
  logInfo("Starting application initialization...");

  try {
    // Step 1: Initialize default WiFi configuration
    await wifiManager.initializeDefaultWifi();

    // Step 2: Start WiFi auto-connection monitoring
    if (configManager.isWifiAutoConnectEnabled()) {
      logInfo("Starting WiFi auto-connection monitoring...");
      wifiManager.startMonitoring();
      
      // Initial connection attempt
      setTimeout(async () => {
        logInfo("Attempting initial WiFi auto-connection...");
        try {
          await wifiManager.attemptAutoConnection();
        } catch (error) {
          logError('Initial WiFi connection attempt failed:', error);
        }
      }, 3000);
    }

    // Step 3: Wait for internet connection before proceeding
    let internetAvailable = false;
    let attempts = 0;
    const maxAttempts = 10;

    while (!internetAvailable && attempts < maxAttempts) {
      attempts++;
      logInfo(`Checking internet connectivity (attempt ${attempts}/${maxAttempts})...`);
      
      internetAvailable = await isInternetConnected();
      
      if (!internetAvailable) {
        if (attempts < maxAttempts) {
          logWarning(`No internet connection. Retrying in 30 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 30000));
        } else {
          logError("Could not establish internet connection after maximum attempts");
          break;
        }
      }
    }

    if (internetAvailable) {
      logSuccess("Internet connection established!");
      
      // Step 4: Test server connectivity
      await testServerConnectivity();
      
      // Step 5: Send active status to central server
      await sendActiveStatus();
      
      // Step 6: Initialize video sync system
      await initializeAndSync();
      await registerDevice();
      startHealthMonitoring();
      
      // Step 7: Start MQTT service only if enabled
      if (mqttService) {
        try {
          await mqttService.connect();
          logSuccess('MQTT service connected successfully');
        } catch (error) {
          logWarning(`MQTT connection failed: ${error.message}`);
          logInfo('Continuing without MQTT - device will use HTTP polling');
        }
      } else {
        logInfo('MQTT disabled - using HTTP polling for updates');
      }
      
      // Step 8: Start auto-update checks
      hybridUpdateService.startPeriodicChecks();
      
      logSuccess("All services initialized successfully");
    } else {
      logWarning("Starting in offline mode - some features will be limited");
      
      // Initialize local services even without internet
      await initializeAndSync();
      startHealthMonitoring();
      
      logInfo("Offline services initialized - will retry when internet is available");
    }
  } catch (error) {
    logError('Error during application initialization:', error);
    
    // Continue with basic services even if WiFi fails
    logInfo('Continuing with basic services despite WiFi issues...');
    await initializeAndSync();
    startHealthMonitoring();
  }
};

// Send active status to central server
async function sendActiveStatus() {
  try {
    const systemInfo = await getSystemInfo();
    const wifiStatus = await wifiManager.getCurrentWifi();

    const statusPayload = {
      rpi_id: RPI_ID,
      rpi_name: RPI_USERNAME,
      rpi_status: "active",
      rpi_serverUrl: `http://localhost:${process.env.PORT || 3000}`,
      device_info: systemInfo,
      app_version: deviceConfig.version,
      last_seen: new Date().toISOString(),
      wifi_ssid: wifiStatus.connected ? wifiStatus.ssid : null
    };

    const axios = await import('axios');
    
    // Try multiple endpoints for status update
    const endpoints = [
      `${SERVER_URL}/api/rpi/update`,
      `${SERVER_URL}/api/devices/register`
    ];
    
    let statusUpdated = false;
    
    for (const endpoint of endpoints) {
      try {
        const response = await axios.default.post(endpoint, statusPayload, {
          timeout: 10000,
          headers: {
            'User-Agent': `ADS-Display/${RPI_ID}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (response.status === 200) {
          logSuccess(`✅ Status updated successfully via ${endpoint}`);
          statusUpdated = true;
          break;
        }
      } catch (error) {
        logWarning(`❌ Status update failed via ${endpoint}: ${error.message}`);
        continue;
      }
    }
    
    if (!statusUpdated) {
      logWarning('❌ Could not update status on central server');
    }
    
  } catch (error) {
    logError('❌ Failed to send active status:', error.message);
  }
}

// Test server connectivity with better error handling
async function testServerConnectivity() {
  try {
    const axios = await import('axios');
    logInfo(`Testing connectivity to central server: ${SERVER_URL}`);
    
    // Test multiple endpoints since /api/health might not exist
    const endpoints = [
      `${SERVER_URL}/api/health`,
      `${SERVER_URL}/health`,
      `${SERVER_URL}/api/videos/active`,
      `${SERVER_URL}/`
    ];
    
    let serverAccessible = false;
    
    for (const endpoint of endpoints) {
      try {
        const response = await axios.default.get(endpoint, {
          timeout: 10000,
          headers: {
            'User-Agent': `ADS-Display/${RPI_ID}`
          }
        });
        
        logSuccess(`✅ Server is accessible via ${endpoint}: ${response.status}`);
        serverAccessible = true;
        
        // If we found a working endpoint, test videos specifically
        if (endpoint.includes('/videos/active')) {
          const videos = response.data.videos || [];
          logInfo(`✅ Video endpoint accessible. Found ${videos.length} videos on server`);
        }
        break; // Stop testing once we find a working endpoint
        
      } catch (error) {
        logInfo(`❌ Endpoint ${endpoint} not accessible: ${error.message}`);
        continue; // Try next endpoint
      }
    }
    
    if (!serverAccessible) {
      logWarning('❌ No server endpoints accessible. Video sync may fail.');
    }
    
  } catch (error) {
    logError(`❌ Server connectivity test failed: ${error.message}`);
    // Don't throw error - we can continue without server connection
  }
}

// Start the server - Use the PORT from .env
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  logWarning(`✔ Server running on port ${PORT}`);
  logInfo(`✔ Device ID: ${RPI_ID}`);
  logInfo(`✔ Raspberry Pi Username: ${RPI_USERNAME}`);
  logInfo(`✔ Version: ${deviceConfig.version}`);
  logInfo(`✔ MQTT: ${MQTT_BROKER !== 'disabled' ? 'Enabled' : 'Disabled'}`);
  logInfo(`✔ Central Server: ${SERVER_URL}`);
  logInfo(`✔ Default WiFi: ${wifiManager.getDefaultWifi().ssid}`);
  
  await initApp();
});

// Graceful shutdown - send offline status before exiting
process.on('SIGTERM', async () => {
  logInfo('Received SIGTERM, shutting down gracefully');
  
  // Stop WiFi monitoring
  wifiManager.stopMonitoring();
  
  // Send offline status to central server (if internet available)
  try {
    if (await isInternetConnected()) {
      await updateDeviceStatus("in_active");
      logInfo('Offline status sent to central server');
    }
  } catch (error) {
    logError('Failed to send offline status:', error);
  }
  
  if (mqttService) {
    await mqttService.disconnect();
  }
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logError('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logError('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});