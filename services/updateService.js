// import { exec } from "child_process";
// import axios from "axios";
// import { logSuccess, logError, logInfo } from "../utils/logger.js"; // Assumes custom logging functions are available
// import { packageJson } from "../server.js";

// const REMOTE_PACKAGE_URL = "https://raw.githubusercontent.com/salihkm0/pi_server/main/package.json"; // Raw file URL

// // Function to check for version updates and apply them if needed
// export const autoUpdate = async () => {
//   const localVersion = packageJson.version;
//   try {
//     // Fetch the remote package.json to check for version changes
//     const response = await axios.get(REMOTE_PACKAGE_URL);
//     const remoteVersion = response.data.version;

//     logInfo(`Local version: ${localVersion}, Remote version: ${remoteVersion}`);

//     // Compare versions
//     if (remoteVersion !== localVersion) {
//       logInfo("New version detected. Updating the application...");

//       // Pull latest code and install dependencies
//       await runCommand("git pull");
//       await runCommand("npm install");

//       logSuccess("Update successful. Restarting application...");

//       // Restart the application
//       process.exit(0);
//     } else {
//       logInfo("No updates available. Running the latest version.");
//     }
//   } catch (error) {
//     logError("Error checking for updates:", error.response ? error.response.data : error);
//   }
// };

// // Utility function to run shell commands
// const runCommand = (cmd) =>
//   new Promise((resolve, reject) => {
//     exec(cmd, (error, stdout, stderr) => {
//       if (error) {
//         logError(`Error executing command ${cmd}:`, error);
//         reject(error);
//       } else {
//         logInfo(`Command output for ${cmd}:\n${stdout || stderr}`);
//         resolve();
//       }
//     });
//   });

import { exec } from "child_process";
import axios from "axios";
import dns from "dns";
import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";
import { packageJson } from "../server.js";
import { isInternetConnected } from "../utils/internetConnection.js";
import { isServerReachable } from "../utils/connectionUtils.js";
import clc from "cli-color";

// Raw file URL
const REMOTE_PACKAGE_URL =
  "https://raw.githubusercontent.com/salihkm0/pi_server/main/package.json";

// Function to check for version updates and apply them if needed
export const autoUpdate = async () => {
  const localVersion = packageJson.version;
  try {
    const online = await isServerReachable();
    if (!online) {
      logWarning("Offline mode: Skipping update");
      return;
    }
    // Check internet connection
    // const connected = await isInternetConnected();
    // if (!connected) {
    //   logInfo("Skipping update check due to no internet connection.");
    //   return;
    // }

    // Fetch the remote package.json to check for version changes
    const response = await axios.get(REMOTE_PACKAGE_URL);
    const remoteVersion = response.data.version;

    logInfo(
      `Local version : `,
      clc.whiteBright(localVersion),
      ` Remote version : `,
      clc.whiteBright(remoteVersion)
    );

    // Compare versions
    if (remoteVersion !== localVersion) {
      logInfo("New version detected. Updating the application...");

      // Pull latest code and install dependencies
      await runCommand("git pull");
      await runCommand("npm install");

      logSuccess("Update successful. Restarting application...");

      // Restart the application
      process.exit(0);
    } else {
      logInfo("No updates available. Running the latest version.");
    }
  } catch (error) {
    logError(
      "Error checking for updates:",
      error.response ? error.response.data : error.message
    );
  }
};

// Utility function to run shell commands
const runCommand = (cmd) =>
  new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        logError(`Error executing command ${cmd}:`, error);
        reject(error);
      } else {
        logInfo(`Command output for ${cmd}:\n${stdout || stderr}`);
        resolve();
      }
    });
  });
