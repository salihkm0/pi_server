import clc from "cli-color";

export const logSuccess = (message) => console.log(clc.green.bold("✔ " + message));
export const logError = (message, error = null) => {
  console.error(clc.red.bold("✖ " + message), error ? error : "");
};
export const logInfo = (message) => console.log(clc.blue.bold("ℹ " + message));
export const logWarning = (message) => console.log(clc.yellow.bold("⚠ " + message));
