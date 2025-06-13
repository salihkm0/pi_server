import express from "express";
import path from "path";
import fs from "fs";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { initializeAndSync } from "./services/initializeAndSync.js";
import { notifyMainServer } from "./services/notificationService.js";
import routes from "./routes/index.js";
import { autoUpdate } from "./services/updateService.js";
import { logWarning } from "./utils/logger.js";
import displayRouter from "./routes/displayRoutes.js";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// export const SERVER_URL = `http://localhost:5557`;
export const SERVER_URL = `https://iot-ads-display.onrender.com`;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const VIDEOS_DIR = path.join(__dirname, "./ads-videos");

// Read piDetails.json file
export const piDetails = JSON.parse(
  fs.readFileSync(path.join(__dirname, "./piDetails/piDetails.json"), "utf-8")
);
console.log("Pi Details:", piDetails);

export const RPI_ID = piDetails.pi_id;



console.log("App Version", piDetails.app_version);

app.use("/videos", express.static(VIDEOS_DIR));

app.use("/api", routes);
app.use("/api", displayRouter);

initializeAndSync();

// Start the Pi server
app.listen(3000, async () => {
  logWarning(`✔ Server running on port 3000`);
  // Notify the main server of the Pi server's online status
  await notifyMainServer();

  // Schedule the auto-update check every hour (3600000 ms)
  // setInterval(autoUpdate, 3600000); // Check for updates every hour
  // setInterval(autoUpdate, 60000); // Check for updates every minute
});
