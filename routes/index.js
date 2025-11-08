import express from "express";
import fs from "fs";
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

routes.get("/videos-list", (req, res) => {
  try {
    const videos = fs
      .readdirSync(VIDEOS_DIR)
      .filter((file) => file.endsWith(".mp4"))
      .map(file => {
        const stats = fs.statSync(`${VIDEOS_DIR}/${file}`);
        return {
          filename: file,
          size: stats.size,
          modified: stats.mtime
        };
      });
    
    res.json({ 
      success: true,
      count: videos.length,
      videos: videos 
    });
  } catch (error) {
    logError("Error fetching video list:", error);
    res.status(500).json({ 
      success: false,
      message: "Failed to retrieve video list" 
    });
  }
});

// System info endpoint
routes.get("/system-info", async (req, res) => {
  try {
    const { getSystemInfo, getDeviceInfo } = await import("../utils/systemInfo.js");
    const systemInfo = await getSystemInfo();
    const deviceInfo = getDeviceInfo();
    
    res.json({
      success: true,
      system: systemInfo,
      device: deviceInfo
    });
  } catch (error) {
    logError("Error getting system info:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Configuration endpoint
routes.get("/config", async (req, res) => {
  try {
    const { configManager } = await import("../services/configManager.js");
    const config = await configManager.loadConfig();
    
    // Don't expose sensitive information
    const safeConfig = { ...config };
    if (safeConfig.wifi) {
      delete safeConfig.wifi.password;
    }
    
    res.json({
      success: true,
      config: safeConfig
    });
  } catch (error) {
    logError("Error getting config:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default routes;