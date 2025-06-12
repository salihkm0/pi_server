import fs from "fs";
import path from "path";
import clc from "cli-color";
import { downloadVideo, fetchVideosList } from "../services/videoService.js";
import { isServerReachable } from "../utils/connectionUtils.js";
import { VIDEOS_DIR } from "../server.js";
import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";
import { exec } from "child_process";

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

  const serverVideos = await fetchVideosList();
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
    (filename) => !serverFilenames.includes(filename)
  );
  if (videosToDownload.length === 0 && videosToDelete.length === 0) {
    console.log(clc.cyan.bold("✔ All videos are up to date."));
    logSuccess("Sync complete.");
    return;
  }
  for (const video of videosToDownload) {
    const filenameWithExt = video.filename.endsWith(".mp4")
      ? video.filename
      : `${video.filename}.mp4`;
    const localPath = path.join(VIDEOS_DIR, filenameWithExt);
    await downloadVideo(video);
    logSuccess(`Downloaded: ${filenameWithExt}`);
    try {
      await sendToMPV({ command: ["loadfile", localPath, "append-play"] });
      logSuccess(`Added ${filenameWithExt} to MPV playlist.`);
    } catch (err) {
      logError(`Failed to add ${filenameWithExt} to MPV playlist`, err);
    }
  }
  for (const filename of videosToDelete) {
    const filePath = path.join(VIDEOS_DIR, filename);
    fs.unlink(filePath, async (err) => {
      if (err) {
        logError(`Failed to delete ${clc.red(filename)}`, err);
      } else {
        logSuccess(`Deleted extra file: ${filename}`);
      }
    });
  }
  logSuccess("Sync complete.");
};
