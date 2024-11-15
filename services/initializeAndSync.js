import fs from "fs";
import clc from "cli-color";
import { VIDEOS_DIR } from "../server.js";
import { downloadVideo, fetchVideosList } from "./videoService.js";
import { syncVideos } from "../controllers/syncController.js";


// Initial setup to download all videos if the directory is empty
export const initializeAndSync = async () =>{
    if (!fs.existsSync(VIDEOS_DIR)) {
      fs.mkdirSync(VIDEOS_DIR);
    }
  
    const localFilenames = fs.readdirSync(VIDEOS_DIR);
  
    // Initial download if no files are found locally
    if (localFilenames.length === 0) {
      console.log(
        clc.yellow.bold("⚠ No videos found locally. Downloading all videos...")
      );
      const serverVideos = await fetchVideosList();
      for (const video of serverVideos) {
        await downloadVideo(video);
      }
      console.log(clc.green.bold("✔ Initial download complete."));
    } else {
      console.log(
        clc.yellow.bold("⚠ Videos already exist locally. Starting regular sync.")
      );
    }
  
    // Start periodic syncing
    setInterval(syncVideos, 60 * 1000); // Every minute
  }