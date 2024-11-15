import fs from "fs";
import path from "path";
import clc from "cli-color";
import { downloadVideo, fetchVideosList } from "../services/videoService.js";
import { isServerReachable } from "../utils/connectionUtils.js";
import { VIDEOS_DIR } from "../server.js";
import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";

// Sync function: Download new videos and delete old ones if online
export const syncVideos = async () => {
  logInfo("Starting sync...");

  const online = await isServerReachable();
  if (!online) {
    logWarning("Offline mode: Skipping sync and deletions.");
    return;
  }
  const serverVideos = await fetchVideosList();
  const serverFilenames = serverVideos.map((video) =>
    video.filename.endsWith(".mp4") ? video.filename : `${video.filename}.mp4`
  );
  const localFilenames = fs.readdirSync(VIDEOS_DIR);

  // Identify new videos to download
  const videosToDownload = serverVideos.filter(
    (video) =>
      !localFilenames.includes(
        video.filename.endsWith(".mp4")
          ? video.filename
          : `${video.filename}.mp4`
      )
  );

  // Identify extra local files to delete
  const videosToDelete = localFilenames.filter(
    (filename) => !serverFilenames.includes(filename)
  );

  // Log a message if everything is up to date
  if (videosToDownload.length === 0 && videosToDelete.length === 0) {
    console.log(clc.cyan.bold("All videos are up to date."));
  }

  // Download new videos
  for (const video of videosToDownload) {
    await downloadVideo(video);
  }

  // Delete extra local videos
  for (const filename of videosToDelete) {
    const filePath = path.join(VIDEOS_DIR, filename);
    fs.unlink(filePath, (err) => {
      if (err) {
        logError("Failed to delete ") + clc.red(filename), err;
      } else {
        logSuccess(`Deleted extra file: ${filename}`);
      }
    });
  }

  logSuccess("Sync complete.");
};
