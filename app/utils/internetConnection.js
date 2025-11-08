import dns from "dns";
import { logSuccess, logError, logInfo } from "../utils/logger.js";

// Function to check internet connectivity
export const isInternetConnected = async () => {
  return new Promise((resolve) => {
    dns.lookup("google.com", (err) => {
      if (err) {
        logError("No internet connection detected.");
        resolve(false);
      } else {
        logSuccess("Internet connection detected.");
        resolve(true);
      }
    });
  });
};

// Enhanced internet check with multiple methods
export const checkInternetConnection = async () => {
  const checks = [
    checkDnsResolution(),
    checkHttpRequest(),
    checkPing()
  ];

  const results = await Promise.all(checks);
  return results.some(result => result === true);
};

const checkDnsResolution = () => {
  return new Promise((resolve) => {
    dns.lookup("google.com", (err) => {
      resolve(!err);
    });
  });
};

const checkHttpRequest = async () => {
  try {
    const { default: axios } = await import('axios');
    await axios.get('https://www.google.com', { timeout: 10000 });
    return true;
  } catch (error) {
    return false;
  }
};

const checkPing = async () => {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    await execAsync('ping -c 1 -W 3 8.8.8.8');
    return true;
  } catch (error) {
    return false;
  }
};