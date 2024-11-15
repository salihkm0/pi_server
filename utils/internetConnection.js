import dns from "dns";
import { logSuccess, logError, logInfo } from "../utils/logger.js";

// Function to check internet connectivity
export const isInternetConnected = async () => {
  return new Promise((resolve) => {
    dns.lookup("8.8.8.8", (err) => {
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
