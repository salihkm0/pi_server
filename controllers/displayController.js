import { exec } from "child_process"


/**
 * Get display details using xrandr.
 * @returns {Promise<object[]>} - A promise resolving to an array of display details.
 */
export const getDisplayDetails = () => {
    return new Promise((resolve, reject) => {
      exec("xrandr --query", (error, stdout, stderr) => {
        if (error) {
          return reject(`Error executing xrandr: ${stderr}`);
        }
  
        const displays = [];
        const lines = stdout.split("\n");
  
        lines.forEach((line) => {
          if (line.includes(" connected")) {
            const [name] = line.split(" ");
            const resolutionMatch = line.match(/(\d+x\d+)/);
            const resolution = resolutionMatch ? resolutionMatch[0] : "Unknown";
  
            displays.push({
              name,
              status: "connected",
              resolution,
            });
          } else if (line.includes(" disconnected")) {
            const [name] = line.split(" ");
            displays.push({
              name,
              status: "disconnected",
              resolution: "N/A",
            });
          }
        });
  
        resolve(displays);
      });
    });
  };