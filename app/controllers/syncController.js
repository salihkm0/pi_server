import fs from "fs";
import path from "path";
import clc from "cli-color";
import { downloadVideo, fetchVideosList } from "../services/videoService.js";
import { isServerReachable } from "../utils/connectionUtils.js";
import { VIDEOS_DIR } from "../server.js";
import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const MPV_SOCKET = "/tmp/mpv-socket";

// Utility: Send JSON command to MPV via IPC
function sendToMPV(commandObj) {
  return new Promise((resolve, reject) => {
    const cmd = `echo '${JSON.stringify(commandObj)}' | socat - ${MPV_SOCKET}`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        reject(stderr || err);
      } else {
        resolve(stdout);
      }
    });
  });
}

// Check if MPV is running and accessible
const isMPVRunning = async () => {
  try {
    if (!fs.existsSync(MPV_SOCKET)) {
      return false;
    }
    
    // Test MPV connection
    await sendToMPV({ command: ["get_property", "pause"] });
    return true;
  } catch (error) {
    return false;
  }
};

export const syncVideos = async () => {
  logInfo("Starting video synchronization...");

  const online = await isServerReachable();
  if (!online) {
    logWarning("Offline mode: Skipping sync and deletions.");
    logSuccess("Sync complete.");
    return;
  }

  if (!fs.existsSync(VIDEOS_DIR)) {
    fs.mkdirSync(VIDEOS_DIR, { recursive: true });
    logInfo(`Created directory: ${VIDEOS_DIR}`);
  }

  const serverVideos = await fetchVideosList();
  
  if (!serverVideos || serverVideos.length === 0) {
    logWarning("No videos received from server. Skipping sync.");
    return;
  }

  const serverFilenames = serverVideos.map((video) =>
    video.filename.endsWith(".mp4") ? video.filename : `${video.filename}.mp4`
  );

  const localFilenames = fs.readdirSync(VIDEOS_DIR);

  const videosToDownload = serverVideos.filter((video) => {
    const filenameWithExt = video.filename.endsWith(".mp4")
      ? video.filename
      : `${video.filename}.mp4`;
    return !localFilenames.includes(filenameWithExt);
  });

  const videosToDelete = localFilenames.filter(
    (filename) => !serverFilenames.includes(filename) && filename.endsWith('.mp4')
  );

  if (videosToDownload.length === 0 && videosToDelete.length === 0) {
    console.log(clc.cyan.bold("✔ All videos are up to date."));
    logSuccess("Sync complete.");
    return;
  }

  logInfo(`Changes detected: ${videosToDownload.length} to download, ${videosToDelete.length} to delete`);

  // Download new videos
  for (const video of videosToDownload) {
    const filenameWithExt = video.filename.endsWith(".mp4")
      ? video.filename
      : `${video.filename}.mp4`;
    
    try {
      await downloadVideo(video);
      logSuccess(`Downloaded: ${filenameWithExt}`);
      
      // Only add to playlist if MPV is running
      const mpvRunning = await isMPVRunning();
      if (mpvRunning) {
        try {
          const localPath = path.join(VIDEOS_DIR, filenameWithExt);
          await sendToMPV({ 
            command: ["loadfile", localPath, "append-play"] 
          });
          logSuccess(`Added ${filenameWithExt} to MPV playlist.`);
        } catch (err) {
          logError(`Failed to add ${filenameWithExt} to MPV playlist:`, err);
        }
      }
    } catch (error) {
      logError(`Failed to download ${filenameWithExt}:`, error.message);
    }
  }

  // Delete removed videos
  for (const filename of videosToDelete) {
    const filePath = path.join(VIDEOS_DIR, filename);
    try {
      fs.unlinkSync(filePath);
      logSuccess(`Deleted: ${filename}`);
    } catch (err) {
      logError(`Failed to delete ${filename}:`, err);
    }
  }

  // Refresh MPV playlist if running
  const mpvRunning = await isMPVRunning();
  if (mpvRunning && (videosToDownload.length > 0 || videosToDelete.length > 0)) {
    try {
      await sendToMPV({ command: ["playlist-clear"] });
      
      // Add all current videos to playlist
      const currentVideos = fs.readdirSync(VIDEOS_DIR).filter(f => f.endsWith('.mp4'));
      for (const videoFile of currentVideos) {
        const videoPath = path.join(VIDEOS_DIR, videoFile);
        await sendToMPV({ 
          command: ["loadfile", videoPath, "append"] 
        });
      }
      
      logSuccess("MPV playlist refreshed with current videos");
    } catch (error) {
      logError("Failed to refresh MPV playlist:", error);
    }
  }

  logSuccess(`Sync completed. Downloaded: ${videosToDownload.length}, Deleted: ${videosToDelete.length}`);
};