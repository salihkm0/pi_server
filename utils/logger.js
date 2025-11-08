import clc from "cli-color";

export const logSuccess = (message) =>
  console.log(clc.green.bold("✔ " + message));
export const logError = (message, error = null) => {
  console.error(clc.red.bold("✖ " + message), error ? error : "");
};
export const logInfo = (message) => console.log(clc.blue.bold("ℹ " + message));
export const logWarning = (message) =>
  console.log(clc.yellow.bold("⚠ " + message));

// Additional logging functions for deployment
export const logDebug = (message) => 
  console.log(clc.magenta("[DEBUG] " + message));

export const logSystem = (message) =>
  console.log(clc.cyan("[SYSTEM] " + message));

// Structured logging for JSON outputs
export const logJson = (data, label = "JSON") => {
  console.log(clc.cyan(`[${label}]`), JSON.stringify(data, null, 2));
};