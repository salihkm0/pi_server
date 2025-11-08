import axios from "axios";
import { logError, logSuccess, logInfo, logWarning } from "../utils/logger.js";

export const fetchPublicUrl = async (retries = 5, delay = 5000) => {
  // Try multiple ngrok API endpoints (different versions/configurations)
  const ngrokEndpoints = [
    "http://localhost:4040/api/tunnels",
    "http://127.0.0.1:4040/api/tunnels",
    "http://localhost:4040/api/tunnels?format=json"
  ];

  for (let attempt = 1; attempt <= retries; attempt++) {
    for (const endpoint of ngrokEndpoints) {
      try {
        logInfo(`Attempt ${attempt}: Trying ngrok endpoint: ${endpoint}`);
        
        const response = await axios.get(endpoint, {
          timeout: 10000,
          headers: {
            'Accept': 'application/json'
          }
        });
        
        const tunnels = response.data.tunnels;

        if (tunnels && tunnels.length > 0) {
          // Find the HTTPS tunnel first, then fallback to HTTP
          const httpsTunnel = tunnels.find(tunnel => tunnel.proto === 'https');
          const httpTunnel = tunnels.find(tunnel => tunnel.proto === 'http');
          const anyTunnel = tunnels[0];
          
          const publicUrl = httpsTunnel?.public_url || httpTunnel?.public_url || anyTunnel?.public_url;
          
          if (publicUrl) {
            logSuccess(`✅ Fetched public URL: ${publicUrl}`);
            return publicUrl;
          } else {
            logWarning("Found tunnels but no public URL");
          }
        } else {
          logWarning(`No active tunnels found at ${endpoint}`);
        }
      } catch (error) {
        if (error.code === 'ECONNREFUSED') {
          logWarning(`Ngrok not running at ${endpoint}`);
        } else if (error.response) {
          logWarning(`Ngrok API error: ${error.response.status} - ${error.response.statusText}`);
        } else {
          logWarning(`Error fetching from ${endpoint}: ${error.message}`);
        }
      }
    }

    if (attempt < retries) {
      logInfo(`Retrying in ${delay / 1000} seconds... (${retries - attempt} attempts remaining)`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  logError("❌ Exhausted all retries. Failed to fetch public URL from ngrok.");
  return null;
};

// Check if ngrok is running
export const checkNgrokStatus = async () => {
  try {
    const response = await axios.get("http://localhost:4040/status", {
      timeout: 5000
    });
    return {
      running: true,
      status: response.status,
      data: response.data
    };
  } catch (error) {
    return {
      running: false,
      error: error.message
    };
  }
};

// Start ngrok tunnel programmatically (if ngrok is installed)
export const startNgrokTunnel = async (port = 3000) => {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    logInfo(`Starting ngrok tunnel for port ${port}...`);
    
    // Check if ngrok is already running
    try {
      await execAsync('pgrep ngrok');
      logInfo('Ngrok is already running');
      return await fetchPublicUrl(3, 2000);
    } catch (error) {
      // Ngrok not running, start it
    }
    
    // Start ngrok in background
    const command = `ngrok http ${port} --log=stdout > /tmp/ngrok.log 2>&1 &`;
    await execAsync(command);
    
    logInfo('Ngrok tunnel started in background');
    
    // Wait for tunnel to be ready
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Try to get the public URL
    const publicUrl = await fetchPublicUrl(5, 3000);
    return publicUrl;
    
  } catch (error) {
    logError(`Failed to start ngrok: ${error.message}`);
    return null;
  }
};

// Stop ngrok tunnel
export const stopNgrokTunnel = async () => {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    await execAsync('pkill -f ngrok');
    logInfo('Ngrok tunnel stopped');
    return true;
  } catch (error) {
    logError(`Failed to stop ngrok: ${error.message}`);
    return false;
  }
};