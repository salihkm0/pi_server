import fs from "fs";
import { VIDEOS_DIR } from "../server.js";
import { downloadAllVideos, fetchVideosList } from "./videoService.js";
import { syncService } from "./syncService.js";
import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";

// Ensure the video directory exists
const ensureVideosDirectory = () => {
  if (!fs.existsSync(VIDEOS_DIR)) {
    fs.mkdirSync(VIDEOS_DIR, { recursive: true });
    logInfo(`Created directory: ${VIDEOS_DIR}`);
  }
};

// Download all videos initially if no local files exist
const initialDownloadIfEmpty = async () => {
  try {
    const localFilenames = fs.readdirSync(VIDEOS_DIR);

    if (localFilenames.length === 0) {
      logWarning("No videos found locally. Downloading all videos...");
      const serverVideos = await fetchVideosList();
      if (serverVideos && serverVideos.length > 0) {
        await downloadAllVideos(serverVideos);
        logSuccess("Initial download complete.");
      } else {
        logWarning("No videos available on server for initial download.");
      }
    } else {
      logInfo(`Found ${localFilenames.length} existing videos. Starting regular sync.`);
    }
  } catch (error) {
    logError("Error during initial download:", error);
  }
};

// Periodic syncing with adaptive intervals
const startSyncInterval = () => {
  let syncInterval = 10 * 60 * 1000; // Start with 10 minutes
  
  const performSync = async () => {
    try {
      logInfo(`Syncing videos at ${new Date().toLocaleTimeString()}`);
      await syncService.syncVideos();
      // Reset to normal interval on success
      syncInterval = 10 * 60 * 1000;
    } catch (error) {
      logError("Sync failed, increasing interval:", error);
      // Double the interval on error (max 1 hour)
      syncInterval = Math.min(syncInterval * 2, 60 * 60 * 1000);
    }
    
    // Schedule next sync
    setTimeout(performSync, syncInterval);
  };
  
  logInfo("Starting adaptive sync interval...");
  setTimeout(performSync, 30000); // Start first sync after 30 seconds
};

// Initialize and sync videos
export const initializeAndSync = async () => {
  ensureVideosDirectory();
  await initialDownloadIfEmpty();
  startSyncInterval();
};