// import { exec } from "child_process";
// import axios from "axios";
// import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";
// import { isServerReachable } from "../utils/connectionUtils.js";
// import clc from "cli-color";
// import { piDetails } from "../server.js";

// // Raw file URL
// const REMOTE_PACKAGE_URL =
//   "https://raw.githubusercontent.com/salihkm0/pi_server/main/piDetails.json";

// // Function to check for version updates and apply them if needed
// export const autoUpdate = async () => {
//   const localVersion = piDetails.app_version;
//   try {
//     const online = await isServerReachable();
//     if (!online) {
//       logWarning("Offline mode: Skipping update");
//       return;
//     }

//     // Fetch the remote package.json to check for version changes
//     const response = await axios.get(REMOTE_PACKAGE_URL);
//     const remoteVersion = response.data.app_version;

//     logInfo(
//       `Local version : ` +
//         clc.whiteBright(localVersion) +
//         ` Remote version : ` +
//         clc.whiteBright(remoteVersion)
//     );

//     // Compare versions
//     if (remoteVersion !== localVersion) {
//       logInfo("New version detected. Updating the application...");

//       // Pull latest code and install dependencies
//       await runCommand("git pull");
//       await runCommand("npm install");

//       logSuccess("Update successful. Restarting application...");

//       // Restart the application using PM2
//       await runCommand("pm2 restart pi-server");
//     } else {
//       console.log(
//         clc.blue("No updates available. Running the ") +
//           clc.green.bold("latest version.")
//       );
//     }
//   } catch (error) {
//     logError(
//       "Error checking for updates:",
//       error.response ? error.response.data : error.message
//     );
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
import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";
import { isServerReachable } from "../utils/connectionUtils.js";
import clc from "cli-color";
import { piDetails } from "../server.js";

// Raw file URL
const REMOTE_PACKAGE_URL =
  "https://raw.githubusercontent.com/salihkm0/pi_server/main/piDetails.json";

// Function to check for version updates and apply them if needed
export const autoUpdate = async () => {
  const localVersion = piDetails.app_version;
  try {
    const online = await isServerReachable();
    if (!online) {
      logWarning("Offline mode: Skipping update");
      return;
    }

    // Fetch the remote piDetails.json to check for version changes
    const response = await axios.get(REMOTE_PACKAGE_URL);
    const remoteVersion = response.data.app_version;

    logInfo(
      `Local version : ` +
        clc.whiteBright(localVersion) +
        ` Remote version : ` +
        clc.whiteBright(remoteVersion)
    );

    // Compare versions and check if an update is required
    if (remoteVersion !== localVersion) {
      logInfo("New version detected. Updating the application...");

      // Pull latest code and install dependencies
      await runCommand("git pull");
      await runCommand("npm install");

      logSuccess("Update successful. Restarting application...");

      // Restart the application using PM2
      await runCommand("pm2 restart pi-server");
    } else {
      logInfo(
        clc.blue("No updates available. Running the ") +
          clc.green.bold("latest version.")
      );
    }
  } catch (error) {
    logError(
      "Error checking for updates:",
      error.response?.data || error.message || error
    );
  }
};

// Utility function to run shell commands
const runCommand = (cmd) =>
  new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        logError(`Error executing command "${cmd}":`, stderr || error);
        reject(error);
      } else {
        logInfo(`Command output for "${cmd}":\n${stdout}`);
        resolve();
      }
    });
  });
