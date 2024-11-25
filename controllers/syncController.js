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
    logSuccess("Sync complete.");
    return;
  }

  if (!fs.existsSync(VIDEOS_DIR)) {
    fs.mkdirSync(VIDEOS_DIR);
    logInfo(`Created directory: ${VIDEOS_DIR}`);
  }

  // Fetch videos from the server
  const serverVideos = await fetchVideosList();
  const serverFilenames = serverVideos.map((video) =>
    video.filename.endsWith(".mp4") ? video.filename : `${video.filename}.mp4`
  );

  // Read local files
  const localFilenames = fs.readdirSync(VIDEOS_DIR);

  // Identify videos to download
  const videosToDownload = serverVideos.filter((video) => {
    const filenameWithExt = video.filename.endsWith(".mp4")
      ? video.filename
      : `${video.filename}.mp4`;
    const localPath = path.join(VIDEOS_DIR, filenameWithExt);
    return !localFilenames.includes(filenameWithExt);
  });

  // Identify videos to delete
  const videosToDelete = localFilenames.filter(
    (filename) => !serverFilenames.includes(filename) // Only delete files not in the server list
  );

  // Log if everything is up to date
  if (videosToDownload.length === 0 && videosToDelete.length === 0) {
    console.log(clc.cyan.bold("✔ All videos are up to date."));
    logSuccess("Sync complete.");
    return;
  }

  // Download new videos
  for (const video of videosToDownload) {
    const filenameWithExt = video.filename.endsWith(".mp4")
      ? video.filename
      : `${video.filename}.mp4`;
    const localPath = path.join(VIDEOS_DIR, filenameWithExt);

    // Download the video
    await downloadVideo(video);
    logSuccess(`Downloaded: ${filenameWithExt}`);

    exec(`echo "add ${localPath}" | nc localhost 4212`, (err) => {
      if (err) logError(`Failed to add ${filenameWithExt} to VLC playlist`, err);
      else logSuccess(`Added ${filenameWithExt} to VLC playlist.`);
    });
  }

  // Delete extra local videos
  for (const filename of videosToDelete) {
    const filePath = path.join(VIDEOS_DIR, filename);
    fs.unlink(filePath, (err) => {
      if (err) {
        logError(`Failed to delete ${clc.red(filename)}`, err);
      } else {
        logSuccess(`Deleted extra file: ${filename}`);

        // clear VLC playlist if needed
        exec(`echo "playlist clear" | nc localhost 4212`, (err) => {
          if (err) logError(`Failed to clear VLC playlist after deleting ${filename}`, err);
          else logInfo("VLC playlist cleared.");
        });
      }
    });
  }

  logSuccess("Sync complete.");
};
