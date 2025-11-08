import fs from "fs";
import path from "path";
import axios from "axios";
import { VIDEOS_DIR } from "../server.js";
import { logSuccess, logError } from "../utils/logger.js";

export const downloadVideoController = async (req, res) => {
  const { filename, fileUrl } = req.body;
  const filePath = path.join(VIDEOS_DIR, `${filename}.mp4`);

  try {
    const response = await axios({
      url: fileUrl,
      method: "GET",
      responseType: "stream",
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    writer.on("finish", () => {
      logSuccess(`Downloaded and saved video: ${filename}.mp4`);
      res.json({ message: "Video downloaded successfully" });
    });

    writer.on("error", (err) => {
      logError("Error writing file:", err);
      res.status(500).json({ message: "Failed to download video" });
    });
  } catch (error) {
    logError("Error downloading video:", error);
    res.status(500).json({ message: "Failed to download video", error });
  }
};
