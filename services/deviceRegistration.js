import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";
import { RPI_ID, RPI_USERNAME, SERVER_URL } from "../server.js";
import { getSystemInfo, getCurrentDeviceId } from "../utils/systemInfo.js";
import { fetchPublicUrl, startNgrokTunnel } from "./tunnelService.js";
import { wifiManager } from "./wifiManager.js";
import { isInternetConnected } from "./videoService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper function to get app version from package.json
const getAppVersion = () => {
  try {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    
    if (fs.existsSync(packageJsonPath)) {
      const packageData = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      return packageData.version || "1.0.0";
    }
    
    // Fallback: check in current directory
    const localPackagePath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(localPackagePath)) {
      const packageData = JSON.parse(fs.readFileSync(localPackagePath, 'utf8'));
      return packageData.version || "1.0.0";
    }
    
    logWarning('⚠️ package.json not found, using default version');
    return "1.0.0";
  } catch (error) {
    logError('❌ Error reading package.json:', error.message);
    return "1.0.0";
  }
};

// Enhanced device registration with internet check - UPDATED VERSION
export const registerDevice = async (retries = 3) => {
  // Debug username detection first
  console.log("🔍 DEBUG: Starting username detection debug...");
  await debugUsernameDetection();
  
  // Check internet before attempting registration
  if (!await isInternetConnected()) {
    logWarning('🌐 No internet connection - skipping device registration');
    return false;
  }

  // Verify we have a consistent device ID
  const currentId = getCurrentDeviceId();
  if (currentId && currentId !== RPI_ID) {
    logError(`Device ID mismatch! Current: ${currentId}, Expected: ${RPI_ID}`);
  }

  // Get app version from package.json
  const appVersion = getAppVersion();
  logInfo(`📦 App Version from package.json: ${appVersion}`);

  // Try to get public URL from ngrok
  let publicUrl = await fetchPublicUrl();
  
  // If no public URL, try to start ngrok
  if (!publicUrl) {
    logInfo("No existing ngrok tunnel found. Attempting to start one...");
    publicUrl = await startNgrokTunnel(process.env.PORT || 3000);
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Check internet before each attempt
      if (!await isInternetConnected()) {
        logWarning('🌐 Internet connection lost during registration attempt');
        throw new Error('No internet connection');
      }

      const systemInfo = await getSystemInfo();
      const wifiStatus = await wifiManager.getCurrentWifi();
      
      // DEBUG: Log what username was detected
      logInfo(`👤 System info reports username: ${systemInfo.username}`);
      logInfo(`👤 RPI_USERNAME constant: ${RPI_USERNAME}`);
      
      // If both are "pi", force a re-detection
      if (systemInfo.username === 'pi' && RPI_USERNAME === 'pi') {
        logWarning("⚠️ Username detection shows 'pi' - this might be incorrect!");
        logWarning("💡 Try running: whoami");
        logWarning("💡 Or check: ls /home/");
      }
      
      // Convert capabilities object to array of strings
      const capabilitiesArray = [
        "video_playback",
        "auto_updates", 
        "health_monitoring",
        "mqtt",
        "wifi_management",
        "resume_downloads"
      ];

      const payload = {
        rpi_id: RPI_ID,
        rpi_name: RPI_USERNAME, // Use Raspberry Pi username
        device_info: systemInfo,
        app_version: appVersion, // Use version from package.json
        location: "auto-detected",
        status: "active",
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        mac_address: systemInfo.mac_address,
        serial_number: systemInfo.serial_number,
        capabilities: capabilitiesArray,
        // DO NOT send any WiFi information
        // REMOVED: wifi_ssid, wifi_password
        ...(publicUrl && { rpi_serverUrl: publicUrl }) // Include public URL if available
      };

      logInfo(`📝 Attempting device registration with ID: ${RPI_ID}, Username: ${RPI_USERNAME}, Version: ${appVersion}`);
      logInfo(`🔍 Device ID breakdown: ${RPI_ID}`);
      
      if (wifiStatus.connected) {
        logInfo(`📡 Current WiFi: ${wifiStatus.ssid}`);
      } else {
        logWarning(`⚠️ No WiFi connection available`);
      }
      
      // DEBUG: Log what we're sending
      logInfo(`📤 Registration payload (NO WiFi included): ${JSON.stringify(payload)}`);
      
      if (publicUrl) {
        logInfo(`🌐 Using public URL: ${publicUrl}`);
      } else {
        logWarning("❌ No public URL available - using localhost");
      }
      
      // Try the primary endpoint first
      const response = await axios.post(`${SERVER_URL}/api/devices/register`, payload, {
        timeout: 15000,
        headers: {
          'User-Agent': `ADS-Display/${RPI_ID}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 200 || response.status === 201) {
        logSuccess(`✅ Device registered successfully with central server (ID: ${RPI_ID}, Username: ${RPI_USERNAME})`);
        
        // Log the response for debugging
        if (response.data) {
          logInfo(`📋 Registration response: ${JSON.stringify(response.data)}`);
          
          // Check if server says WiFi is configured
          if (response.data.device && response.data.device.wifi_configured) {
            logInfo(`📡 Server WiFi Status: Configured - ${response.data.device.wifi_ssid || 'SSID not shown'}`);
          } else {
            logInfo(`📡 Server WiFi Status: Not configured`);
          }
        }
        
        return true;
      } else {
        throw new Error(`Unexpected response status: ${response.status}`);
      }
    } catch (error) {
      logError(`❌ Registration attempt ${attempt} failed:`, error.message);
      
      if (error.response) {
        logError(`❌ Server response: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        
        // If it's rate limiting (429), wait longer
        if (error.response.status === 429) {
          const delay = attempt * 30000; // 30, 60, 90 seconds for rate limiting
          logInfo(`🔄 Rate limited. Waiting ${delay/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // If it's a schema validation error, we can try a simpler payload
        if (error.response.status === 500 && error.response.data?.error?.includes('CastError')) {
          logInfo('🔄 Trying simplified registration payload...');
          await trySimplifiedRegistration(attempt, publicUrl, appVersion);
          continue;
        }
      }
      
      if (attempt < retries) {
        const delay = attempt * 10000; // 10, 20, 30 seconds
        logInfo(`🔄 Retrying registration in ${delay/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  logError(`❌ All registration attempts failed for device: ${RPI_ID}`);
  return false;
};

// Simplified registration for schema issues - ALSO NO WIFI
async function trySimplifiedRegistration(attempt, publicUrl, appVersion) {
  try {
    const systemInfo = await getSystemInfo();
    
    // DO NOT get WiFi status for registration
    const simplifiedPayload = {
      rpi_id: RPI_ID,
      rpi_name: RPI_USERNAME,
      device_info: {
        mac_address: systemInfo.mac_address,
        serial_number: systemInfo.serial_number,
        model: systemInfo.model,
        os: systemInfo.os,
        hostname: systemInfo.hostname,
        username: systemInfo.username
      },
      app_version: appVersion, // Use version from package.json
      location: "auto-detected",
      rpi_status: "active",
      last_seen: new Date().toISOString(),
      // NO WiFi here either
      ...(publicUrl && { rpi_serverUrl: publicUrl })
    };

    logInfo(`🔄 Trying simplified registration (NO WiFi)...`);
    
    const response = await axios.post(`${SERVER_URL}/api/rpi/update`, simplifiedPayload, {
      timeout: 15000,
      headers: {
        'User-Agent': `ADS-Display/${RPI_ID}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.status === 200) {
      logSuccess(`✅ Device registered via simplified payload (attempt ${attempt})`);
      
      if (publicUrl) {
        logSuccess(`🌐 Public URL saved: ${publicUrl}`);
      }
      return true;
    }
  } catch (error) {
    logError(`❌ Simplified registration failed: ${error.message}`);
  }
  return false;
}

// Update device status on central server with public URL
export const updateDeviceStatus = async (status = "active", systemInfo = null) => {
  // Check internet before attempting status update
  if (!await isInternetConnected()) {
    logWarning('🌐 No internet connection - skipping status update');
    return false;
  }

  try {
    if (!systemInfo) {
      systemInfo = await getSystemInfo();
    }

    // Get app version from package.json
    const appVersion = getAppVersion();

    // Try to get current public URL
    const publicUrl = await fetchPublicUrl(2, 3000);

    // Use the simplified payload for status updates - NO WIFI
    const payload = {
      rpi_id: RPI_ID,
      rpi_name: RPI_USERNAME,
      rpi_status: status,
      device_info: {
        mac_address: systemInfo.mac_address,
        serial_number: systemInfo.serial_number,
        model: systemInfo.model,
        os: systemInfo.os,
        hostname: systemInfo.hostname,
        username: systemInfo.username
      },
      app_version: appVersion, // Include version in status updates too
      last_seen: new Date().toISOString(),
      // DO NOT send WiFi SSID
      ...(publicUrl && { rpi_serverUrl: publicUrl })
    };

    logInfo(`🔄 Updating device status to: ${status} (Version: ${appVersion})`);
    
    if (publicUrl) {
      logInfo(`🌐 Using public URL: ${publicUrl}`);
    }

    // Try multiple endpoints for status update
    const endpoints = [
      `${SERVER_URL}/api/rpi/update`,
      `${SERVER_URL}/api/devices/register`
    ];

    for (const endpoint of endpoints) {
      try {
        const response = await axios.post(endpoint, payload, {
          timeout: 10000,
          headers: {
            'User-Agent': `ADS-Display/${RPI_ID}`,
            'Content-Type': 'application/json'
          }
        });

        if (response.status === 200) {
          logSuccess(`✅ Status updated to ${status} via ${endpoint}`);
          if (publicUrl) {
            logSuccess(`🌐 Public URL updated: ${publicUrl}`);
          }
          return true;
        }
      } catch (error) {
        logWarning(`❌ Status update failed via ${endpoint}: ${error.message}`);
        if (error.response) {
          logWarning(`❌ Response: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        }
        continue;
      }
    }

    logError('❌ All status update attempts failed');
    return false;

  } catch (error) {
    logError('❌ Failed to update device status:', error.message);
    return false;
  }
};

// Check if device is already registered
export const checkDeviceRegistration = async () => {
  try {
    const response = await axios.get(`${SERVER_URL}/api/devices/${RPI_ID}`, {
      timeout: 10000,
      headers: {
        'User-Agent': `ADS-Display/${RPI_ID}`
      }
    });
    
    return response.status === 200;
  } catch (error) {
    return false; // Device not registered or error
  }
};

// Get current public URL and update device record
export const updateDevicePublicUrl = async () => {
  try {
    const publicUrl = await fetchPublicUrl();
    if (publicUrl) {
      await updateDeviceStatus("active");
      return publicUrl;
    }
    return null;
  } catch (error) {
    logError('❌ Failed to update device public URL:', error);
    return null;
  }
};