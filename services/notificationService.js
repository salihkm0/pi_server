import axios from "axios";
import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";
import { RPI_ID, SERVER_URL } from "../server.js";
import { isServerReachable } from "../utils/connectionUtils.js";

export const notifyMainServer = async () => {
  try {
    const online = await isServerReachable();
    if (!online) {
      logWarning("Offline mode: server is not reachable");
      return;
    }
    await axios.post(`https://iot-ads-display.onrender.com/api/notify-online`, {
      rpi_id: RPI_ID,
    });
    logSuccess("Notified main server of online status");
  } catch (error) {
    logError("Failed to notify main server!");
  }
};
