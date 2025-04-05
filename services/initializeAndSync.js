import fs from "fs";
import { VIDEOS_DIR } from "../server.js";
import { downloadAllVideos, fetchVideosList } from "./videoService.js";
import { syncVideos } from "../controllers/syncController.js";
import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";

// Ensure the video directory exists
const ensureVideosDirectory = () => {
  if (!fs.existsSync(VIDEOS_DIR)) {
    fs.mkdirSync(VIDEOS_DIR);
    logInfo(`Created directory: ${VIDEOS_DIR}`);
  }
};

// Download all videos initially if no local files exist
const initialDownloadIfEmpty = async () => {
  const localFilenames = fs.readdirSync(VIDEOS_DIR);

  if (localFilenames.length === 0) {
    logWarning("No videos found locally. Downloading all videos...");
    try {
      const serverVideos = await fetchVideosList();
      await downloadAllVideos(serverVideos); 
      logSuccess("Initial download complete.");
    } catch (error) {
      logError("Error during initial download:", error);
    }
  } else {
    logWarning("Videos already exist locally. Starting regular sync.");
  }
};

// Periodic syncing every 60 seconds
const startSyncInterval = () => {
  logInfo("Starting regular sync every 60 seconds...");
  setInterval(() => {
    logInfo(`Syncing videos at ${new Date().toLocaleTimeString()}`);
    syncVideos();
  }, 60 * 1000);
};

// Initialize and sync videos
export const initializeAndSync = async () => {
  ensureVideosDirectory();
  await initialDownloadIfEmpty();
  startSyncInterval();
};
