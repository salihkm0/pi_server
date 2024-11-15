
import fs from "fs";
import path from "path";
import axios from "axios";
// import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";
import clc from "cli-color";
import { SERVER_URL, VIDEOS_DIR } from "../server.js";

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
        const percentComplete = Math.round((loaded * 100) / total);
        process.stdout.write(
          clc.blue.bold(
            `Downloading ${filenameWithExt}: ${percentComplete}% complete\r`
          )
        );
      },
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on("finish", () => {
        console.log(
          clc.green.bold("\n✔ Download complete: ") + clc.green(filenameWithExt)
        );
        resolve();
      });
      writer.on("error", reject);
    });
  } catch (error) {
    console.log(
      clc.red.bold("✖ Failed to download ") + clc.red(filenameWithExt),
      error
    );
  }
};


export const fetchVideosList = async() => {
    try {
      const response = await axios.get(`${SERVER_URL}/api/videos`);
      const videos = response.data;
      return videos;
    } catch (error) {
      console.error(clc.red.bold("✖ Error fetching videos list:", error));
      return [];
    }
  }