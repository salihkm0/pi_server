import axios from "axios";
import { logSuccess, logError } from "../utils/logger.js";
import { RPI_ID, SERVER_URL } from "../server.js";

export const notifyMainServer = async () => {
  try {
    await axios.post(`https://iot-ads-display.onrender.com/api/notify-online`, { rpi_id: RPI_ID });
    logSuccess("Notified main server of online status");
  } catch (error) {
    logError("Failed to notify main server:", error);
  }
};
