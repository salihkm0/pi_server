

import fs from "fs";
import path from "path";
import clc from "cli-color";
import axios from "axios";
import { VIDEOS_DIR } from "../server.js";


export const deleteVideoController =async (req,res) => {
    const { filename } = req.body;
  const filePath = path.join(VIDEOS_DIR, filename + ".mp4");

  if (fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error(clc.red.bold("✖ Failed to delete file:", err));
        return res.status(500).json({ message: "Failed to delete file" });
      }
      console.log(clc.green.bold(`✔ Deleted file: ${filename}`));
      res.json({ message: "File deleted successfully" });
    });
  } else {
    res.status(404).json({ message: "File not found" });
  }
}