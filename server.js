// import express from "express";
// import cors from "cors";
// import dotenv from "dotenv";
// import path from "path";
// import { notifyMainServer } from "./services/notificationService.js";
// import { downloadVideoController } from "./controllers/downloadController.js";
// import { fileURLToPath } from "url";
// import clc from "cli-color";
// import fs from "fs";
// import { initializeAndSync } from "./services/initializeAndSync.js";
// import { deleteVideoController } from "./controllers/deleteController.js";

// dotenv.config();

// const app = express();
// app.use(express.json());
// app.use(cors());

// export const SERVER_URL = process.env.MAIN_SERVER_URL;
// const RPI_ID = process.env.RPI_ID;

// // Check for required environment variables
// if (!SERVER_URL || !RPI_ID) {
//   console.log(clc.red.bold("✖ SERVER_URL or RPI_ID is missing in environment variables."));
//   process.exit(1);
// }

// // Define the base directory path for video storage
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);
// export const VIDEOS_DIR = path.join(__dirname, "./ads-videos");

// // Ensure VIDEOS_DIR is accessible globally
// console.log(clc.blue.bold(`Videos directory path: ${VIDEOS_DIR}`));

// // initializeAndSync();
// initializeAndSync(SERVER_URL)

// app.use("/videos", express.static(path.join(path.resolve(), "./ads-videos")));

// app.get("/status", (req, res) => res.status(200).send("Server is online"));
// app.post("/download-video", downloadVideoController);
// app.post("/delete-video", deleteVideoController);

// app.listen(3001, async () => {
//   console.log("✔ Server running on port 3001");
//   await notifyMainServer(SERVER_URL, process.env.RPI_ID);
// });

import express from "express";
import fs from "fs";
import path from "path";
import clc from "cli-color";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { initializeAndSync } from "./services/initializeAndSync.js";
import { notifyMainServer } from "./services/notificationService.js";
import routes from "./routes/index.js";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

export const SERVER_URL = `https://iot-ads-display.onrender.com`;
export const RPI_ID = process.env.RPI_ID || `piserver_0002`
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const VIDEOS_DIR = path.join(__dirname, "./ads-videos");

app.use("/videos", express.static(VIDEOS_DIR));

app.use("/",routes)

initializeAndSync();

// Start the Pi server
app.listen(3001, async () => {
  console.log(clc.yellow.bold(`✔ Server running on port 3001`));
  // Notify the main server of the Pi server's online status
  await notifyMainServer();
});
