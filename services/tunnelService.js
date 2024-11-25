// import axios from "axios";
// import { logError, logSuccess } from "../utils/logger.js";

// export const fetchPublicUrl = async () => {
//   try {
//     const response = await axios.get("http://localhost:4040/api/tunnels");
//     const tunnels = response.data.tunnels;

//     if (tunnels && tunnels.length > 0) {
//       const publicUrl = tunnels[0].public_url;
//       logSuccess(`Fetched public URL: ${publicUrl}`);
//       return publicUrl;
//     } else {
//       logError("No tunnels found in ngrok response.");
//       return null;
//     }
//   } catch (error) {
//     logError(`Error fetching public URL: ${error.message}`);
//     return null;
//   }
// };


import axios from "axios";
import { logError, logSuccess, logInfo } from "../utils/logger.js";

export const fetchPublicUrl = async (retries = 5, delay = 5000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get("http://localhost:4040/api/tunnels");
      const tunnels = response.data.tunnels;

      if (tunnels && tunnels.length > 0) {
        const publicUrl = tunnels[0].public_url;
        logSuccess(`Fetched public URL: ${publicUrl}`);
        return publicUrl;
      } else {
        logError("No tunnels found in ngrok response.");
      }
    } catch (error) {
      logError(`Attempt ${attempt}: Error fetching public URL: ${error.message}`);
    }

    if (attempt < retries) {
      logInfo(`Retrying to fetch public URL in ${delay / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, delay)); // Wait before retrying
    }
  }

  logError("Exhausted all retries. Failed to fetch public URL.");
  return null;
};
