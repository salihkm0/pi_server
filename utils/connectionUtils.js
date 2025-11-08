import { SERVER_URL } from "../server.js";
import axios from "axios";
import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";

// Utility function to check internet connection by pinging the server
export const isServerReachable = async () => {
  try {
    const serverRes = await axios.get(`${SERVER_URL}/api/rpi/ping`);
    if (serverRes.status === 200 && serverRes.data.success) {
      logSuccess("Main server is reachable");
      return true;
    } else {
      logInfo("Main server response was not successful");
      return false;
    }
  } catch (error) {
    console.log(error)
    if (error.response) {
      // Server responded but with a status other than 200
      logError("Main server error response:", error);
    } else if (error.request) {
      // No response received from server
      logError("No response received from main server");
    } else {
      // Error setting up the request
      logError("Error setting up server check request:", error.message);
    }
    logWarning("Unable to reach server. Skipping sync.");
    return false;
  }
};

// Enhanced connectivity check with multiple endpoints
export const checkConnectivity = async () => {
  const testEndpoints = [
    'https://www.google.com',
    'https://www.cloudflare.com',
    SERVER_URL
  ];

  for (const endpoint of testEndpoints) {
    try {
      const response = await axios.get(endpoint, { timeout: 10000 });
      if (response.status === 200) {
        logSuccess(`Connectivity confirmed via ${endpoint}`);
        return true;
      }
    } catch (error) {
      logWarning(`Failed to reach ${endpoint}: ${error.message}`);
    }
  }

  logError("All connectivity tests failed");
  return false;
};