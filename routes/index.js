import express from "express";
import fs from "fs";
import clc from "cli-color";
import { VIDEOS_DIR } from "../server.js";
import { downloadVideoController } from "../controllers/downloadController.js";
import { deleteVideoController } from "../controllers/deleteController.js";
import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";

const routes = express.Router();

routes.get("/status", (req, res) => {
  res.status(200).send("Server is online");
});
routes.post("/download-video", downloadVideoController);
routes.post("/delete-video", deleteVideoController);
routes.get("/api/videos-list", (req, res) => {
  try {
    const videos = fs
      .readdirSync(VIDEOS_DIR)
      .filter((file) => file.endsWith(".mp4"));
    res.json({ videos });
  } catch (error) {
    logError("✖ Error fetching video list:"), error;
    res.status(500).json({ message: "Failed to retrieve video list" });
  }
});

export default routes;
