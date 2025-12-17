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
const USERNAME_FILE = path.join(__dirname, '../../original_username.txt');

// Get original Raspberry Pi username (works even when running as root with sudo)
export const getRaspberryPiUsername = async () => {
  try {
    console.log("🕵️ Attempting to detect Raspberry Pi username...");
    
    // Method 1: Check if we have saved the original username
    if (fs.existsSync(USERNAME_FILE)) {
      const savedUsername = fs.readFileSync(USERNAME_FILE, 'utf8').trim();
      if (savedUsername && savedUsername !== 'pi') {
        console.log("✅ Using saved username from file:", savedUsername);
        return savedUsername;
      }
    }
    
    // Method 2: Check if running as root with sudo
    const isRunningAsRoot = process.getuid && process.getuid() === 0;
    console.log(`🔧 Running as root? ${isRunningAsRoot}`);
    
    if (isRunningAsRoot) {
      // When running as root with sudo, try these methods in order:
      
      // Method 2A: Check SUDO_USER environment variable
      if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root') {
        console.log("✅ Found username from SUDO_USER:", process.env.SUDO_USER);
        saveOriginalUsername(process.env.SUDO_USER);
        return process.env.SUDO_USER;
      }
      
      // Method 2B: Check LOGNAME environment variable
      if (process.env.LOGNAME && process.env.LOGNAME !== 'root') {
        console.log("✅ Found username from LOGNAME:", process.env.LOGNAME);
        saveOriginalUsername(process.env.LOGNAME);
        return process.env.LOGNAME;
      }
      
      // Method 2C: Check USER environment variable
      if (process.env.USER && process.env.USER !== 'root') {
        console.log("✅ Found username from USER:", process.env.USER);
        saveOriginalUsername(process.env.USER);
        return process.env.USER;
      }
      
      // Method 2D: Check who am i or who
      try {
        const commands = [
          "who | awk '{print $1}' | grep -v root | head -1",
          "who am i | awk '{print $1}'",
          "last -n 1 | grep -v 'reboot' | awk '{print $1}'"
        ];
        
        for (const cmd of commands) {
          try {
            const { stdout } = await execAsync(cmd);
            const username = stdout.trim();
            if (username && username !== 'root') {
              console.log(`✅ Found username via '${cmd}':`, username);
              saveOriginalUsername(username);
              return username;
            }
          } catch (cmdError) {
            continue;
          }
        }
      } catch (error) {
        console.log("Could not get username from who commands:", error.message);
      }
      
      // Method 2E: Check home directories in /home
      try {
        const { stdout } = await execAsync("ls -la /home/ | grep '^d' | grep -v 'lost+found' | awk '{print $9}' | head -1");
        const username = stdout.trim();
        if (username && username !== 'root') {
          console.log("✅ Found username from /home directory:", username);
          saveOriginalUsername(username);
          return username;
        }
      } catch (error) {
        console.log("Could not get username from /home directory:", error.message);
      }
    }
    
    // Method 3: Check /etc/passwd for non-system users
    try {
      // Get users with login shell and home directory in /home
      const { stdout } = await execAsync("getent passwd | grep -E ':/home/[^:]+:/bin/' | grep -v 'nologin' | cut -d: -f1 | head -1");
      const username = stdout.trim();
      if (username && username !== 'root') {
        console.log("✅ Found username from /etc/passwd:", username);
        saveOriginalUsername(username);
        return username;
      }
    } catch (error) {
      console.log("Could not get username from /etc/passwd:", error.message);
    }
    
    // Method 4: Check for running processes to determine original user
    try {
      // Look for processes not run by root
      const { stdout } = await execAsync("ps aux | grep -v root | grep -v '\\[' | awk '{print $1}' | grep -v 'USER' | head -1");
      const username = stdout.trim();
      if (username && username !== 'root') {
        console.log("✅ Found username from running processes:", username);
        saveOriginalUsername(username);
        return username;
      }
    } catch (error) {
      console.log("Could not get username from processes:", error.message);
    }
    
    // Method 5: Check the directory where the app is running
    try {
      const cwd = process.cwd();
      if (cwd.includes('/home/')) {
        const parts = cwd.split('/');
        for (let i = 0; i < parts.length; i++) {
          if (parts[i] === 'home' && i + 1 < parts.length) {
            const possibleUsername = parts[i + 1];
            if (possibleUsername && possibleUsername !== 'root') {
              console.log("✅ Extracted username from current path:", possibleUsername);
              saveOriginalUsername(possibleUsername);
              return possibleUsername;
            }
          }
        }
      }
    } catch (error) {
      console.log("Could not extract username from path:", error.message);
    }
    
    // Method 6: Check actual user info (works even when not root)
    try {
      // This should work even without sudo
      const { stdout } = await execAsync("id -un");
      const username = stdout.trim();
      if (username && username !== 'root') {
        console.log("✅ Found username from 'id -un':", username);
        saveOriginalUsername(username);
        return username;
      }
    } catch (error) {
      console.log("Could not get username from id command:", error.message);
    }
    
    // Method 7: Check $HOME environment variable
    const homeDir = process.env.HOME;
    if (homeDir && homeDir.includes('/home/')) {
      const parts = homeDir.split('/');
      const username = parts[parts.length - 1];
      if (username && username !== 'root') {
        console.log("✅ Extracted username from HOME directory:", username);
        saveOriginalUsername(username);
        return username;
      }
    }
    
    // If all methods fail, check if "pi" is actually the correct username
    try {
      const { stdout } = await execAsync("id pi 2>/dev/null || echo 'no pi user'");
      if (stdout.includes('uid=')) {
        console.log("✅ Username 'pi' exists on this system");
        saveOriginalUsername('pi');
        return 'pi';
      }
    } catch (error) {
      console.log("User 'pi' does not exist on this system");
    }
    
    // Final fallback: Check current directory owner
    try {
      const { stdout } = await execAsync("stat -c '%U' . 2>/dev/null || ls -ld . | awk '{print $3}'");
      const username = stdout.trim();
      if (username && username !== 'root') {
        console.log("✅ Found username from directory owner:", username);
        saveOriginalUsername(username);
        return username;
      }
    } catch (error) {
      console.log("Could not get directory owner:", error.message);
    }
    
    // Ultimate fallback
    console.log("⚠️ Could not determine original username, performing manual check...");
    
    // Try to manually check what users exist
    try {
      const manualCheckCmds = [
        "cat /etc/passwd | cut -d: -f1 | grep -E '^(ubuntu|debian|admin|user|raspberry|pi|kali|linux)' | head -1",
        "ls /home/ | head -1"
      ];
      
      for (const cmd of manualCheckCmds) {
        try {
          const { stdout } = await execAsync(cmd);
          const username = stdout.trim();
          if (username) {
            console.log(`✅ Manual check found username: ${username}`);
            saveOriginalUsername(username);
            return username;
          }
        } catch (cmdError) {
          continue;
        }
      }
    } catch (error) {
      console.log("Manual check failed:", error.message);
    }
    
    // If we still can't find it, check what username you might have set
    console.log("❌ Could not detect Raspberry Pi username!");
    console.log("💡 Please check what username you used to log into your Raspberry Pi:");
    console.log("   Run this command in terminal: `whoami`");
    console.log("   Or check: `echo $USER`");
    console.log("   Or check: `ls /home/` to see available users");
    
    // Try to prompt or use environment variable
    const possibleUsername = process.env.USERNAME || process.env.USER || 'pi';
    console.log(`📝 Using fallback username: ${possibleUsername}`);
    saveOriginalUsername(possibleUsername);
    return possibleUsername;
    
  } catch (error) {
    console.error("❌ Error getting Raspberry Pi username:", error);
    
    // Try to save debugging info
    try {
      const debugInfo = {
        error: error.message,
        env: {
          SUDO_USER: process.env.SUDO_USER,
          USER: process.env.USER,
          LOGNAME: process.env.LOGNAME,
          HOME: process.env.HOME,
          USERNAME: process.env.USERNAME
        },
        cwd: process.cwd(),
        uid: process.getuid ? process.getuid() : 'unknown',
        timestamp: new Date().toISOString()
      };
      
      const debugFile = path.join(__dirname, '../../username_debug.json');
      fs.writeFileSync(debugFile, JSON.stringify(debugInfo, null, 2));
      console.log("📝 Debug info saved to username_debug.json");
    } catch (debugError) {
      // Ignore debug errors
    }
    
    // Ultimate fallback
    const fallbackUsername = 'pi';
    saveOriginalUsername(fallbackUsername);
    return fallbackUsername;
  }
};

// Save the original username to file
const saveOriginalUsername = (username) => {
  try {
    const dir = path.dirname(USERNAME_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(USERNAME_FILE, username);
    console.log("💾 Saved original username to file:", username);
  } catch (error) {
    console.error("Error saving username:", error);
  }
};

// Get or create a permanent device ID using Raspberry Pi username
export const getDeviceId = async () => {
  try {
    console.log("🆔 Generating device ID...");
    
    // Try to read existing device ID first
    if (fs.existsSync(DEVICE_ID_FILE)) {
      const existingId = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf8'));
      if (existingId.deviceId) {
        console.log("📋 Using existing device ID:", existingId.deviceId);
        console.log("👤 Associated username:", existingId.username);
        return existingId.deviceId;
      }
    }

    // Get Raspberry Pi username (using our enhanced method)
    const username = await getRaspberryPiUsername();
    let deviceId = '';
    let method = '';
    
    console.log(`👤 Detected username: ${username}`);

    // Check if we're on Raspberry Pi by looking for Pi-specific files
    const isRaspberryPi = fs.existsSync('/proc/device-tree/model') && 
                          fs.readFileSync('/proc/device-tree/model', 'utf8').includes('Raspberry Pi');

    if (isRaspberryPi) {
      console.log("🍓 Raspberry Pi detected - generating unique ID...");
      
      // Method 1: Use username + CPU serial number (most reliable on Pi)
      try {
        const serial = await execAsync("cat /proc/cpuinfo | grep Serial | cut -d ' ' -f 2");
        const serialTrimmed = serial.stdout.trim();
        if (serialTrimmed && serialTrimmed !== "0000000000000000") {
          deviceId = `${username}_${serialTrimmed.toLowerCase()}`;
          method = 'Username + CPU Serial';
          console.log("🔢 Using Raspberry Pi CPU serial number");
        }
      } catch (error) {
        console.log("CPU serial method failed:", error.message);
      }

      // Method 2: Use username + MAC address (fallback)
      if (!deviceId) {
        try {
          // Try all network interfaces
          const networkFiles = fs.readdirSync('/sys/class/net/');
          for (const interfaceName of networkFiles) {
            try {
              const macPath = `/sys/class/net/${interfaceName}/address`;
              if (fs.existsSync(macPath)) {
                const macAddress = fs.readFileSync(macPath, 'utf8').trim();
                if (macAddress && macAddress.length > 0 && !macAddress.includes('00:00:00')) {
                  deviceId = `${username}_${macAddress.replace(/:/g, '').toLowerCase()}`;
                  method = `Username + ${interfaceName} MAC Address`;
                  console.log(`📡 Using MAC address from ${interfaceName}`);
                  break;
                }
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
          const boardSerial = await execAsync("cat /proc/device-tree/serial-number 2>/dev/null | tr -d '\\0' || echo ''");
          const serialTrimmed = boardSerial.stdout.trim();
          if (serialTrimmed) {
            deviceId = `${username}_${serialTrimmed.toLowerCase()}`;
            method = 'Username + Board Serial';
            console.log("💻 Using Raspberry Pi board serial");
          }
        } catch (error) {
          console.log("Board serial method failed:", error.message);
        }
      }

    } else if (process.platform === 'darwin') { // macOS
      console.log("🍎 macOS detected...");
      
      try {
        // Get MAC address on macOS
        const { stdout } = await execAsync("ifconfig en0 | grep ether | awk '{print $2}'");
        const macAddress = stdout.trim();
        if (macAddress && macAddress.length > 0) {
          deviceId = `${username}_${macAddress.replace(/:/g, '').toLowerCase()}`;
          method = 'Username + MAC Address';
          console.log("🍎 Using macOS MAC address");
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
            console.log("🍎 Using macOS serial number");
          }
        } catch (error) {
          console.log("macOS serial method failed:", error.message);
        }
      }
    } else {
      // Other Linux systems or unknown
      console.log("🐧 Linux/Other system detected...");
      
      try {
        // Try MAC address from any interface
        const networkFiles = fs.readdirSync('/sys/class/net/');
        for (const interfaceName of networkFiles) {
          try {
            const macPath = `/sys/class/net/${interfaceName}/address`;
            if (fs.existsSync(macPath)) {
              const macAddress = fs.readFileSync(macPath, 'utf8').trim();
              if (macAddress && macAddress.length > 0 && !macAddress.includes('00:00:00')) {
                deviceId = `${username}_${macAddress.replace(/:/g, '').toLowerCase()}`;
                method = `Username + ${interfaceName} MAC Address`;
                console.log(`🐧 Using MAC address from ${interfaceName}`);
                break;
              }
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
      console.log("🖥️ Using hostname-based device ID");
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
    console.error("❌ Error generating device ID:", error);
    
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

    console.log("🖥️ Gathering system information...");
    console.log("👤 Username detected:", username);

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
      console.log("🍓 Raspberry Pi detected");
      
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
      console.log("🍎 macOS detected");
      
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
      console.log("🐧 Linux/Other system detected");
      
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
      is_raspberry_pi: isRaspberryPi,
      detected_username_method: "enhanced_detection"
    };
  } catch (error) {
    console.error("❌ Error getting system info:", error);
    return {
      username: await getRaspberryPiUsername(),
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
    console.error("❌ Error reading device ID file:", error);
  }
  return null;
};

// Get current username
export const getCurrentUsername = () => {
  try {
    if (fs.existsSync(USERNAME_FILE)) {
      const savedUsername = fs.readFileSync(USERNAME_FILE, 'utf8').trim();
      return savedUsername;
    }
    
    if (fs.existsSync(DEVICE_ID_FILE)) {
      const existing = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf8'));
      return existing.username || 'pi';
    }
  } catch (error) {
    console.error("❌ Error reading device info file:", error);
  }
  return 'pi';
};

// Get device info including how the ID was generated
export const getDeviceInfo = () => {
  try {
    if (fs.existsSync(DEVICE_ID_FILE)) {
      const info = JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf8'));
      console.log("📋 Device Info:", info);
      return info;
    }
  } catch (error) {
    console.error("❌ Error reading device info file:", error);
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
    if (fs.existsSync(USERNAME_FILE)) {
      fs.unlinkSync(USERNAME_FILE);
      console.log("Username file reset");
    }
    console.log("🔄 Please restart the application to generate new IDs");
  } catch (error) {
    console.error("❌ Error resetting device ID:", error);
  }
};

// Debug function to check what username detection finds
export const debugUsernameDetection = async () => {
  console.log("🔍 Debugging username detection...");
  console.log("Environment variables:");
  console.log("  SUDO_USER:", process.env.SUDO_USER);
  console.log("  USER:", process.env.USER);
  console.log("  LOGNAME:", process.env.LOGNAME);
  console.log("  USERNAME:", process.env.USERNAME);
  console.log("  HOME:", process.env.HOME);
  console.log("Current working directory:", process.cwd());
  console.log("Running as root?", process.getuid && process.getuid() === 0);
  
  try {
    const { stdout: whoami } = await execAsync("whoami");
    console.log("whoami:", whoami.trim());
  } catch (error) {
    console.log("whoami failed:", error.message);
  }
  
  try {
    const { stdout: users } = await execAsync("ls /home/");
    console.log("Users in /home/:", users.trim());
  } catch (error) {
    console.log("ls /home/ failed:", error.message);
  }
  
  const username = await getRaspberryPiUsername();
  console.log("Final detected username:", username);
  return username;
};