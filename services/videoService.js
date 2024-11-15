import fs from "fs";
import path from "path";
import axios from "axios";
import { logSuccess, logError, logWarning, logInfo } from "../utils/logger.js";
import { SERVER_URL, VIDEOS_DIR } from "../server.js";
import clc from "cli-color";

export const downloadVideo = async (video) => {
  const filenameWithExt = video.filename.endsWith(".mp4")
    ? video.filename
    : `${video.filename}.mp4`;
  const localPath = path.join(VIDEOS_DIR, filenameWithExt);
  const writer = fs.createWriteStream(localPath);

  try {
    const response = await axios.get(video.fileUrl, {
      responseType: "stream",
      onDownloadProgress: (progressEvent) => {
        const { loaded, total } = progressEvent;

        if (total) {
          const percentComplete = Math.round((loaded * 100) / total);
          process.stdout.write(
            clc.blue.bold(
              `Downloading ${filenameWithExt}: ${percentComplete}% complete\r`
            )
          );
        } else {
          process.stdout.write(
            clc.blue.bold(
              `Downloading ${filenameWithExt}: ${loaded} bytes downloaded\r`
            )
          );
        }
      },
    });

    // Pipe the response data to the local file
    response.data.pipe(writer);

    // Wait for the writing to finish
    return new Promise((resolve, reject) => {
      writer.on("finish", () => {
        console.log(
          clc.green.bold("\n✔ Download complete: ") + clc.green(filenameWithExt)
        );
        resolve();
      });
      writer.on("error", (error) => {
        console.error(clc.red.bold("✖ Error writing file: "), error);
        reject(error);
      });
    });
  } catch (error) {
    console.log(
      clc.red.bold("✖ Failed to download ") + clc.red(filenameWithExt),
      error
    );
    throw error;
  }
};

export const downloadAllVideos = async (videos) => {
  for (const video of videos) {
    try {
      await downloadVideo(video);
    } catch (error) {
      logError(`Error downloading ${video.filename}: `), error;
    }
  }
};

export const fetchVideosList = async () => {
  try {
    const response = await axios.get(`${SERVER_URL}/api/videos`);
    const videos = response.data;
    return videos;
  } catch (error) {
    logError("Error fetching videos list:");
    console.error(error);
    return [];
  }
};
