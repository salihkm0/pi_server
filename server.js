import express from "express";
import path from "path";
import fs from "fs";
import clc from "cli-color";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { initializeAndSync } from "./services/initializeAndSync.js";
import { notifyMainServer } from "./services/notificationService.js";
import routes from "./routes/index.js";
import { autoUpdate } from "./services/updateService.js";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

export const SERVER_URL = `https://iot-ads-display.onrender.com`;
export const RPI_ID = process.env.RPI_ID || `piserver_0002`;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const VIDEOS_DIR = path.join(__dirname, "./ads-videos");

export const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "package.json"), "utf-8")
);

console.log("App Vertion", packageJson.version);

app.use("/videos", express.static(VIDEOS_DIR));

app.use("/", routes);

initializeAndSync();

// Start the Pi server
app.listen(3001, async () => {
  console.log(clc.yellow.bold(`✔ Server running on port 3001`));
  // Notify the main server of the Pi server's online status
  await notifyMainServer();

  // Schedule the auto-update check every hour (3600000 ms)
  // setInterval(autoUpdate, 3600000); // Check for updates every hour
  setInterval(autoUpdate, 60000); // Check for updates every minute
});
