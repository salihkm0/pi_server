import axios from "axios";
import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";
import { RPI_ID, SERVER_URL } from "../server.js";
import { isServerReachable } from "../utils/connectionUtils.js";
import { fetchPublicUrl } from "./tunnelService.js";

export const notifyMainServer = async () => {
  try {
    const online = await isServerReachable();
    if (!online) {
      logWarning("Offline mode: server is not reachable");
      return;
    }

    const publicUrl = await fetchPublicUrl();
    if (!publicUrl) {
      logError("Failed to fetch public URL after retries.");
      // return;
    }

    const payload = {
      rpi_id: RPI_ID,
      rpi_serverUrl: publicUrl ? publicUrl : "",
      rpi_status: "active",
    };

    // const response = await axios.post(`${SERVER_URL}/api/rpi/update`, payload);
    const response = await axios.post(
      `https://iot-ads-display.onrender.com/api/rpi/update`,
      payload
    );

    // await axios.post(`https://iot-ads-display.onrender.com/api/notify-online`, {
    //   rpi_id: RPI_ID,
    // });

    if (response.status === 200) {
      logSuccess("Successfully notified the main server.");
    } else {
      logError(`Unexpected response from main server: ${response.status}`);
    }
  } catch (error) {
    logError("Failed to notify main server!", error);
  }
};
