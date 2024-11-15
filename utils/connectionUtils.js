import clc from "cli-color";
import { SERVER_URL } from "../server.js";
import axios from "axios";

// Utility function to check internet connection by pinging the server
export const isServerReachable = async () =>  {
    console.log(clc.yellow.bold("Checking Internet Connection:"));
    try {
      const serverRes = await axios.get(`${SERVER_URL}/api/ping`);
      console.log("Server Response:", serverRes.status, serverRes.data);
      if (serverRes.status === 200 && serverRes.data.success) {
        console.log(clc.green.bold("✔ Main server is reachable"));
        return true;
      } else {
        console.log(clc.red.bold("✖ Main server response was not successful"));
        return false;
      }
    } catch (error) {
      if (error.response) {
        // Server responded but with a status other than 200
        console.log(clc.red.bold("✖ Main server error response:"), error.response.status);
      } else if (error.request) {
        // No response received from server
        console.log(clc.red.bold("✖ No response received from main server"));
      } else {
        // Error setting up the request
        console.log(clc.red.bold("✖ Error setting up server check request:", error.message));
      }
      console.log(clc.yellow.bold("✖ Unable to reach server. Skipping sync."));
      return false;
    }
  }