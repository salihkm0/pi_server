import axios from "axios";
import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";
import { RPI_ID, SERVER_URL } from "../server.js";
import { isServerReachable } from "../utils/connectionUtils.js";
import { fetchPublicUrl } from "./tunnelService.js";
import { getSystemInfo } from "../utils/systemInfo.js";

export const notifyMainServer = async (retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const online = await isServerReachable();
      if (!online) {
        logWarning("Offline mode: server is not reachable");
        return false;
      }

      const publicUrl = await fetchPublicUrl();
      const systemInfo = await getSystemInfo();

      const payload = {
        rpi_id: RPI_ID,
        rpi_serverUrl: publicUrl || "",
        rpi_status: "active",
        device_info: systemInfo,
        app_version: "1.0.0",
        mac_address: systemInfo.mac_address,
        last_seen: new Date().toISOString()
      };

      let response;
      if (SERVER_URL.includes('localhost')) {
        // Development mode - try both endpoints
        try {
          response = await axios.post(`${SERVER_URL}/api/rpi/update`, payload, { timeout: 10000 });
        } catch (e) {
          response = await axios.post(`https://iot-ads-display.onrender.com/api/rpi/update`, payload, { timeout: 10000 });
        }
      } else {
        // Production mode
        response = await axios.post(`${SERVER_URL}/api/rpi/update`, payload, { timeout: 10000 });
      }

      if (response.status === 200) {
        logSuccess("Successfully notified the main server.");
        return true;
      } else {
        logError(`Unexpected response from main server: ${response.status}`);
      }
    } catch (error) {
      logError(`Notification attempt ${attempt} failed:`, error.message);
      
      if (attempt < retries) {
        logInfo(`Retrying notification in 10 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }
  
  logError("All notification attempts failed");
  return false;
};