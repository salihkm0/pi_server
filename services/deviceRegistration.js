import axios from "axios";
import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";
import { RPI_ID, RPI_USERNAME, SERVER_URL } from "../server.js";
import { getSystemInfo, getCurrentDeviceId } from "../utils/systemInfo.js";
import { fetchPublicUrl, startNgrokTunnel } from "./tunnelService.js";
import { wifiManager } from "./wifiManager.js";
import { isInternetConnected } from "./videoService.js";

// Enhanced device registration with internet check
export const registerDevice = async (retries = 3) => {
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
      const defaultWifi = wifiManager.getDefaultWifi();
      
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
        app_version: "1.0.0",
        location: "auto-detected",
        status: "active",
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        mac_address: systemInfo.mac_address,
        serial_number: systemInfo.serial_number,
        capabilities: capabilitiesArray,
        wifi_ssid: wifiStatus.connected ? wifiStatus.ssid : defaultWifi.ssid,
        wifi_password: defaultWifi.password, // Send default WiFi password to DB
        default_wifi_configured: true,
        ...(publicUrl && { rpi_serverUrl: publicUrl }) // Include public URL if available
      };

      logInfo(`📝 Attempting device registration with ID: ${RPI_ID}, Username: ${RPI_USERNAME}`);
      logInfo(`📡 Default WiFi: ${defaultWifi.ssid}`);
      
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
        logSuccess(`📡 Default WiFi details saved to database: ${defaultWifi.ssid}`);
        
        if (publicUrl) {
          logSuccess(`🌐 Public URL saved to device: ${publicUrl}`);
        }
        
        // Log the response for debugging
        if (response.data) {
          logInfo(`📋 Registration response: ${JSON.stringify(response.data)}`);
        }
        
        return true;
      } else {
        throw new Error(`Unexpected response status: ${response.status}`);
      }
    } catch (error) {
      logError(`❌ Registration attempt ${attempt} failed:`, error.message);
      
      if (error.response) {
        logError(`❌ Server response: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        
        // If it's a schema validation error, we can try a simpler payload
        if (error.response.status === 500 && error.response.data?.error?.includes('CastError')) {
          logInfo('🔄 Trying simplified registration payload...');
          await trySimplifiedRegistration(attempt, publicUrl);
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

// Simplified registration for schema issues
async function trySimplifiedRegistration(attempt, publicUrl) {
  try {
    const systemInfo = await getSystemInfo();
    const wifiStatus = await wifiManager.getCurrentWifi();
    const defaultWifi = wifiManager.getDefaultWifi();
    
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
      app_version: "1.0.0",
      location: "auto-detected",
      rpi_status: "active",
      last_seen: new Date().toISOString(),
      wifi_ssid: wifiStatus.connected ? wifiStatus.ssid : defaultWifi.ssid,
      wifi_password: defaultWifi.password,
      default_wifi_configured: true,
      ...(publicUrl && { rpi_serverUrl: publicUrl })
    };

    const response = await axios.post(`${SERVER_URL}/api/rpi/update`, simplifiedPayload, {
      timeout: 15000,
      headers: {
        'User-Agent': `ADS-Display/${RPI_ID}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.status === 200) {
      logSuccess(`✅ Device registered via simplified payload (attempt ${attempt})`);
      logSuccess(`📡 Default WiFi details saved: ${defaultWifi.ssid}`);
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

    const wifiStatus = await wifiManager.getCurrentWifi();
    const defaultWifi = wifiManager.getDefaultWifi();
    
    // Try to get current public URL
    const publicUrl = await fetchPublicUrl(2, 3000);

    // Use the simplified payload for status updates to avoid schema issues
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
      last_seen: new Date().toISOString(),
      wifi_ssid: wifiStatus.connected ? wifiStatus.ssid : defaultWifi.ssid,
      default_wifi_available: true,
      ...(publicUrl && { rpi_serverUrl: publicUrl })
    };

    logInfo(`🔄 Updating device status to: ${status}`);
    logInfo(`📡 Current WiFi: ${wifiStatus.connected ? wifiStatus.ssid : 'Disconnected'}`);
    
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