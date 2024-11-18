import axios from "axios";
import { logError, logSuccess } from "../utils/logger.js";

export const fetchPublicUrl = async () => {
  try {
    const response = await axios.get("http://localhost:4040/api/tunnels");
    const tunnels = response.data.tunnels;

    if (tunnels && tunnels.length > 0) {
      const publicUrl = tunnels[0].public_url;
      logSuccess(`Fetched public URL: ${publicUrl}`);
      return publicUrl;
    } else {
      logError("No tunnels found in ngrok response.");
      return null;
    }
  } catch (error) {
    logError(`Error fetching public URL: ${error.message}`);
    return null;
  }
};
