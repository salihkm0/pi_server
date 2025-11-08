import { exec } from "child_process";
import { promisify } from "util";
import os from "os";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to store the permanent device ID
const DEVICE_ID_FILE = path.join(__dirname, '../../device_id.json');

// Get Raspberry Pi username
export const getRaspberryPiUsername = async () => {
  try {
    // Try to get the username of the current user
    const { stdout } = await execAsync('whoami');
    const username = stdout.trim();
    
    console.log("🔑 Detected Raspberry Pi username:", username);
    return username;
  } catch (error) {
    console.error("Error getting Raspberry Pi username:", error);
    
    // Fallback to environment variable or hostname
    return process.env.USER || process.env.USERNAME || os.userInfo().username || 'pi';
  }
};

// Get or create a permanent device ID using Raspberry Pi username
export const getDeviceId = async () => {
  try {
    // Try to read existing device ID first
    if (fs.existsSync(DEVICE_ID_FILE)) {
      const existingId = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf8'));
      if (existingId.deviceId) {
        console.log("📋 Using existing device ID:", existingId.deviceId);
        return existingId.deviceId;
      }
    }

    // Get Raspberry Pi username
    const username = await getRaspberryPiUsername();
    let deviceId = '';
    let method = '';

    // Check if we're on Raspberry Pi by looking for Pi-specific files
    const isRaspberryPi = fs.existsSync('/proc/device-tree/model') && 
                          fs.readFileSync('/proc/device-tree/model', 'utf8').includes('Raspberry Pi');

    if (isRaspberryPi) {
      console.log("🍓 Raspberry Pi detected - using username with hardware identifiers");
      
      // Method 1: Use username + CPU serial number (most reliable on Pi)
      try {
        const serial = await execAsync("cat /proc/cpuinfo | grep Serial | cut -d ' ' -f 2");
        const serialTrimmed = serial.stdout.trim();
        if (serialTrimmed && serialTrimmed !== "0000000000000000") {
          deviceId = `${username}_${serialTrimmed.toLowerCase()}`;
          method = 'Username + CPU Serial';
          console.log("🔢 Using Raspberry Pi username + CPU serial number");
        }
      } catch (error) {
        console.log("CPU serial method failed:", error.message);
      }

      // Method 2: Use username + MAC address (fallback)
      if (!deviceId) {
        try {
          // Try eth0 first (wired), then wlan0 (wireless)
          const commands = [
            "cat /sys/class/net/eth0/address",
            "cat /sys/class/net/wlan0/address"
          ];
          
          for (const cmd of commands) {
            try {
              const mac = await execAsync(cmd);
              const macAddress = mac.stdout.trim();
              if (macAddress && macAddress.length > 0) {
                deviceId = `${username}_${macAddress.replace(/:/g, '').toLowerCase()}`;
                method = 'Username + MAC Address';
                console.log("📡 Using Raspberry Pi username + MAC address");
                break;
              }
            } catch (e) {
              continue;
            }
          }
        } catch (error) {
          console.log("MAC address method failed:", error.message);
        }
      }

      // Method 3: Use username + board serial
      if (!deviceId) {
        try {
          const boardSerial = await execAsync("cat /proc/device-tree/serial-number | tr -d '\\0'");
          const serialTrimmed = boardSerial.stdout.trim();
          if (serialTrimmed) {
            deviceId = `${username}_${serialTrimmed.toLowerCase()}`;
            method = 'Username + Board Serial';
            console.log("💻 Using Raspberry Pi username + board serial");
          }
        } catch (error) {
          console.log("Board serial method failed:", error.message);
        }
      }

    } else if (process.platform === 'darwin') { // macOS
      console.log("🍎 macOS detected - using username with system identifiers");
      
      try {
        // Get MAC address on macOS
        const { stdout } = await execAsync("ifconfig en0 | grep ether | awk '{print $2}'");
        const macAddress = stdout.trim();
        if (macAddress && macAddress.length > 0) {
          deviceId = `${username}_${macAddress.replace(/:/g, '').toLowerCase()}`;
          method = 'Username + MAC Address';
          console.log("🍎 Using macOS username + MAC address");
        }
      } catch (error) {
        console.log("macOS MAC address method failed:", error.message);
      }

      // Fallback to system serial on macOS
      if (!deviceId) {
        try {
          const { stdout } = await execAsync("system_profiler SPHardwareDataType | grep 'Serial Number' | awk '{print $4}'");
          const serial = stdout.trim();
          if (serial && serial.length > 0) {
            deviceId = `${username}_${serial.toLowerCase()}`;
            method = 'Username + Serial Number';
            console.log("🍎 Using macOS username + serial number");
          }
        } catch (error) {
          console.log("macOS serial method failed:", error.message);
        }
      }
    } else {
      // Other Linux systems or unknown
      console.log("🐧 Linux/Other system detected - using username");
      
      try {
        // Try MAC address first
        const commands = [
          "cat /sys/class/net/eth0/address",
          "cat /sys/class/net/wlan0/address"
        ];
        
        for (const cmd of commands) {
          try {
            const mac = await execAsync(cmd);
            const macAddress = mac.stdout.trim();
            if (macAddress && macAddress.length > 0) {
              deviceId = `${username}_${macAddress.replace(/:/g, '').toLowerCase()}`;
              method = 'Username + MAC Address';
              console.log("🐧 Using Linux username + MAC address");
              break;
            }
          } catch (e) {
            continue;
          }
        }
      } catch (error) {
        console.log("Linux MAC address method failed:", error.message);
      }
    }

    // Final fallback - username + hostname based (but consistent)
    if (!deviceId) {
      const hostname = os.hostname();
      // Create a consistent hash of the hostname
      let hash = 0;
      for (let i = 0; i < hostname.length; i++) {
        const char = hostname.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
      }
      deviceId = `${username}_${Math.abs(hash).toString(36)}`;
      method = 'Username + Hostname Hash';
      console.log("🖥️ Using username + hostname-based device ID");
    }

    // Save the device ID to file for future use
    const deviceData = {
      deviceId: deviceId,
      username: username,
      created: new Date().toISOString(),
      hostname: os.hostname(),
      platform: process.platform,
      method: method,
      isRaspberryPi: isRaspberryPi,
      systemInfo: {
        arch: os.arch(),
        cores: os.cpus().length,
        memory: Math.round(os.totalmem() / 1024 / 1024)
      }
    };
    
    // Ensure directory exists
    const dir = path.dirname(DEVICE_ID_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify(deviceData, null, 2));
    console.log("💾 Saved device ID to file:", deviceId);
    console.log("🎯 Generation method:", method);
    console.log("👤 Username:", username);
    console.log("🍓 Is Raspberry Pi:", isRaspberryPi);

    return deviceId;
    
  } catch (error) {
    console.error("Error generating device ID:", error);
    
    // Ultimate fallback - check if we have a stored ID from previous runs
    try {
      if (fs.existsSync(DEVICE_ID_FILE)) {
        const existing = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf8'));
        console.log("📋 Recovered existing device ID from file");
        return existing.deviceId;
      }
    } catch (e) {
      console.log("Could not recover existing device ID");
    }
    
    // Last resort - random but saved
    const username = await getRaspberryPiUsername();
    const fallbackId = `${username}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const deviceData = {
      deviceId: fallbackId,
      username: username,
      created: new Date().toISOString(),
      hostname: os.hostname(),
      platform: process.platform,
      note: "Generated as fallback due to error"
    };
    
    const dir = path.dirname(DEVICE_ID_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify(deviceData, null, 2));
    console.log("🚨 Generated fallback device ID due to error");
    return fallbackId;
  }
};

export const getSystemInfo = async () => {
  try {
    let macAddress = "unknown";
    let serial = "unknown";
    let model = "unknown";
    let osInfo = "unknown";
    let isRaspberryPi = false;
    let username = await getRaspberryPiUsername();

    // Detect Raspberry Pi
    try {
      if (fs.existsSync('/proc/device-tree/model')) {
        const modelContent = fs.readFileSync('/proc/device-tree/model', 'utf8');
        isRaspberryPi = modelContent.includes('Raspberry Pi');
        model = modelContent.trim();
      }
    } catch (e) {
      // Not a Raspberry Pi or error reading
    }

    if (isRaspberryPi) {
      console.log("🍓 Gathering Raspberry Pi system information");
      
      // MAC address on Raspberry Pi
      try {
        const commands = [
          "cat /sys/class/net/eth0/address",
          "cat /sys/class/net/wlan0/address"
        ];
        
        for (const cmd of commands) {
          try {
            const mac = await execAsync(cmd);
            macAddress = mac.stdout.trim();
            if (macAddress && macAddress.length > 0) break;
          } catch (e) {
            continue;
          }
        }
      } catch (e) {
        macAddress = "unknown";
      }
      
      // Serial number on Raspberry Pi
      try {
        const serialCmd = await execAsync("cat /proc/cpuinfo | grep Serial | cut -d ' ' -f 2");
        serial = serialCmd.stdout.trim();
      } catch (e) {
        serial = "unknown";
      }
      
      // OS info on Raspberry Pi
      try {
        const osCmd = await execAsync("cat /etc/os-release | grep PRETTY_NAME | cut -d=' -f2 | tr -d '\"'");
        osInfo = osCmd.stdout.trim();
      } catch (e) {
        osInfo = "unknown";
      }
      
    } else if (process.platform === 'darwin') { // macOS
      console.log("🍎 Gathering macOS system information");
      
      try {
        // MAC address on macOS
        const mac = await execAsync("ifconfig en0 | grep ether | awk '{print $2}'");
        macAddress = mac.stdout.trim();
      } catch (e) {
        macAddress = "unknown";
      }
      
      try {
        // Serial number on macOS
        const serialCmd = await execAsync("system_profiler SPHardwareDataType | grep 'Serial Number' | awk '{print $4}'");
        serial = serialCmd.stdout.trim();
      } catch (e) {
        serial = "unknown";
      }
      
      try {
        // Model on macOS
        const modelCmd = await execAsync("system_profiler SPHardwareDataType | grep 'Model Name' | awk -F': ' '{print $2}'");
        model = modelCmd.stdout.trim();
      } catch (e) {
        model = "unknown";
      }
      
      try {
        // macOS version
        const osCmd = await execAsync("sw_vers -productVersion");
        osInfo = `macOS ${osCmd.stdout.trim()}`;
      } catch (e) {
        osInfo = "unknown";
      }
    } else {
      // Other Linux systems
      console.log("🐧 Gathering Linux system information");
      
      try {
        const commands = [
          "cat /sys/class/net/eth0/address",
          "cat /sys/class/net/wlan0/address"
        ];
        
        for (const cmd of commands) {
          try {
            const mac = await execAsync(cmd);
            macAddress = mac.stdout.trim();
            if (macAddress && macAddress.length > 0) break;
          } catch (e) {
            continue;
          }
        }
      } catch (e) {
        macAddress = "unknown";
      }
      
      try {
        const serialCmd = await execAsync("cat /proc/cpuinfo | grep Serial | cut -d ' ' -f 2");
        serial = serialCmd.stdout.trim();
      } catch (e) {
        serial = "unknown";
      }
      
      try {
        const modelCmd = await execAsync("cat /proc/device-tree/model | tr -d '\\0' 2>/dev/null || echo 'unknown'");
        model = modelCmd.stdout.trim();
      } catch (e) {
        model = "unknown";
      }
      
      try {
        const osCmd = await execAsync("cat /etc/os-release | grep PRETTY_NAME | cut -d=' -f2 | tr -d '\"' 2>/dev/null || echo 'unknown'");
        osInfo = osCmd.stdout.trim();
      } catch (e) {
        osInfo = "unknown";
      }
    }
    
    // Memory
    const memory = Math.round(os.totalmem() / 1024 / 1024);
    
    return {
      username: username,
      mac_address: macAddress,
      serial_number: serial,
      model: model,
      os: osInfo,
      architecture: os.arch(),
      cores: os.cpus().length,
      total_memory: `${memory} MB`,
      hostname: os.hostname(),
      uptime: os.uptime(),
      network_interfaces: Object.keys(os.networkInterfaces()),
      platform: process.platform,
      is_raspberry_pi: isRaspberryPi
    };
  } catch (error) {
    console.error("Error getting system info:", error);
    return {
      username: "unknown",
      mac_address: "unknown",
      serial_number: "unknown", 
      model: "unknown",
      os: "unknown",
      architecture: os.arch(),
      cores: os.cpus().length,
      total_memory: "unknown",
      hostname: os.hostname(),
      platform: process.platform,
      is_raspberry_pi: false
    };
  }
};

// Utility function to get the current device ID without generating a new one
export const getCurrentDeviceId = () => {
  try {
    if (fs.existsSync(DEVICE_ID_FILE)) {
      const existing = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf8'));
      return existing.deviceId;
    }
  } catch (error) {
    console.error("Error reading device ID file:", error);
  }
  return null;
};

// Get current username
export const getCurrentUsername = () => {
  try {
    if (fs.existsSync(DEVICE_ID_FILE)) {
      const existing = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf8'));
      return existing.username || 'pi';
    }
  } catch (error) {
    console.error("Error reading device info file:", error);
  }
  return 'pi';
};

// Get device info including how the ID was generated
export const getDeviceInfo = () => {
  try {
    if (fs.existsSync(DEVICE_ID_FILE)) {
      return JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf8'));
    }
  } catch (error) {
    console.error("Error reading device info file:", error);
  }
  return null;
};

// Utility function to reset device ID (for testing)
export const resetDeviceId = () => {
  try {
    if (fs.existsSync(DEVICE_ID_FILE)) {
      fs.unlinkSync(DEVICE_ID_FILE);
      console.log("Device ID reset - new ID will be generated on next startup");
    }
  } catch (error) {
    console.error("Error resetting device ID:", error);
  }
};