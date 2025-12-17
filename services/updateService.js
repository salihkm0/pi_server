import { exec } from "child_process";
import { promisify } from "util";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logSuccess, logError, logInfo, logWarning } from "../utils/logger.js";
import { isServerReachable } from "../utils/connectionUtils.js";
import { RPI_ID, SERVER_URL, mqttService } from "../server.js";
import { configManager } from "./configManager.js";
import clc from "cli-color";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

class HybridUpdateService {
  constructor() {
    this.updateAvailable = false;
    this.lastChecked = null;
    this.currentVersion = this.getCurrentVersion();
    this.updateStrategies = ['git', 'http', 'rsync'];
    this.checkInterval = 30 * 60 * 1000; // 30 minutes
  }

  getCurrentVersion() {
    try {
      // Try multiple possible locations for package.json
      const possiblePaths = [
        path.join(process.cwd(), 'package.json'),
        path.join(__dirname, '..', '..', 'package.json'),
        path.join(__dirname, '..', 'package.json'),
        '/home/pi/ads-display/package.json'
      ];
      
      for (const packageJsonPath of possiblePaths) {
        if (fs.existsSync(packageJsonPath)) {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          logInfo(`Found package.json at: ${packageJsonPath}`);
          return packageJson.version || "1.0.0";
        }
      }
      
      logWarning("package.json not found in any expected location");
      return "1.0.0";
    } catch (error) {
      logError("Error reading package.json:", error);
      return "1.0.0";
    }
  }

  startPeriodicChecks() {
    logInfo(`Starting periodic update checks every ${this.checkInterval/60000} minutes`);
    
    // Initial check after 2 minutes
    setTimeout(() => this.autoUpdate(), 120000);
    
    // Periodic checks
    setInterval(() => this.autoUpdate(), this.checkInterval);
  }

  async autoUpdate() {
    try {
      logInfo("🔍 Checking for updates...");
      this.lastChecked = new Date().toISOString();
      
      const online = await isServerReachable();
      if (!online) {
        logWarning("Offline mode: Skipping update check");
        return false;
      }

      const updateInfo = await this.checkForUpdates();
      
      if (updateInfo.updateAvailable) {
        logInfo(`🔄 Update available: ${this.currentVersion} → ${updateInfo.latestVersion}`);
        
        // Notify via MQTT
        this.publishUpdateStatus('update_available', {
          fromVersion: this.currentVersion,
          toVersion: updateInfo.latestVersion
        });
        
        const success = await this.performUpdate(updateInfo);
        
        if (success) {
          this.currentVersion = updateInfo.latestVersion;
          await configManager.updateConfig({ version: this.currentVersion });
        }
        
        return success;
      } else {
        logInfo(clc.green("✅ Running latest version."));
        return true;
      }
      
    } catch (error) {
      logError("Error during auto-update:", error.message);
      this.publishUpdateStatus('update_failed', { error: error.message });
      return false;
    }
  }

  async checkForUpdates() {
    // Try multiple update sources - only use public endpoints
    const sources = [
      this.checkGitHub(),
      this.checkHealthEndpoint(), // Use public health endpoint
      this.checkSimpleVersion()
    ];

    let lastError = null;
    
    for (const source of sources) {
      try {
        const result = await source;
        if (result && result.updateAvailable) {
          return result;
        }
      } catch (error) {
        lastError = error;
        logWarning(`Update source failed: ${error.message}`);
        continue;
      }
    }

    // If all sources failed, log the last error but don't crash
    if (lastError) {
      logWarning("All update checks failed, assuming current version is latest");
    }
    
    return { updateAvailable: false, latestVersion: this.currentVersion };
  }

  async checkGitHub() {
    try {
      const response = await axios.get(
        "https://raw.githubusercontent.com/salihkm0/pi_server/main/package.json",
        { 
          timeout: 10000,
          headers: { 'Cache-Control': 'no-cache' }
        }
      );
      
      const remotePackage = response.data;
      const latestVersion = remotePackage.version || "1.0.0";
      const updateAvailable = this.currentVersion !== latestVersion;
      
      return {
        updateAvailable,
        latestVersion,
        source: 'github',
        updateUrl: "https://github.com/salihkm0/pi_server.git",
        changelog: remotePackage.changelog
      };
    } catch (error) {
      throw new Error(`GitHub check failed: ${error.message}`);
    }
  }

  async checkHealthEndpoint() {
    try {
      // Use the public health endpoint to check server connectivity
      const response = await axios.get(`${SERVER_URL}/api/health`, {
        timeout: 10000,
        headers: {
          'User-Agent': `ADS-Display/${RPI_ID}`
        }
      });
      
      return {
        updateAvailable: false,
        latestVersion: this.currentVersion,
        source: 'health_check',
        serverReachable: true
      };
      
    } catch (error) {
      throw new Error(`Health endpoint check failed: ${error.message}`);
    }
  }

  async checkSimpleVersion() {
    try {
      // Simple version file check
      return {
        updateAvailable: false,
        latestVersion: this.currentVersion,
        source: 'simple_check'
      };
      
    } catch (error) {
      throw new Error(`Simple version check failed: ${error.message}`);
    }
  }

  async performUpdate(updateInfo) {
    // Only perform updates if we have a reliable source (like GitHub)
    if (updateInfo.source !== 'github') {
      logWarning(`Update source '${updateInfo.source}' not supported for automatic updates`);
      return false;
    }

    // Get the application directory dynamically
    const appDir = process.cwd();
    const backupDir = `/tmp/ads-display-backup-${Date.now()}`;
    
    try {
      logInfo("🚀 Starting update process...");
      logInfo(`Application directory: ${appDir}`);
      logInfo(`Backup directory: ${backupDir}`);
      
      this.publishUpdateStatus('update_started', updateInfo);

      // Step 1: Create backup
      logInfo("📦 Creating backup...");
      await this.createBackup(appDir, backupDir);

      // Step 2: Execute Git update with stash
      const updateSuccess = await this.gitUpdate(appDir, updateInfo);

      if (!updateSuccess) {
        throw new Error('Git update failed');
      }

      // Step 3: Install dependencies and run setup scripts
      await this.installDependenciesAndSetup(appDir);

      // Step 4: Verify update
      const newVersion = this.getCurrentVersion();
      if (newVersion !== updateInfo.latestVersion) {
        logWarning(`Version mismatch after update. Expected: ${updateInfo.latestVersion}, Got: ${newVersion}`);
      }

      // Step 5: Update device registration with new version
      await this.updateDeviceVersion(newVersion);

      // Step 6: Notify success
      this.publishUpdateStatus('update_completed', {
        fromVersion: this.currentVersion,
        toVersion: updateInfo.latestVersion || newVersion
      });

      logSuccess(`✅ Update successful! Version: ${newVersion}`);

      // Step 7: Schedule reboot (after 1 minute to allow cleanup)
      await this.scheduleReboot();

      return true;

    } catch (error) {
      logError("❌ Update failed:", error.message);
      
      // Restore from backup
      await this.restoreBackup(appDir, backupDir);
      
      this.publishUpdateStatus('update_failed', { error: error.message });
      
      return false;
    } finally {
      // Cleanup backup
      await this.cleanupBackup(backupDir);
    }
  }

  async gitUpdate(appDir, updateInfo) {
    logInfo("🔄 Using Git update strategy...");
    
    try {
      // First, ensure we're in the correct directory
      const gitDir = path.resolve(appDir);
      
      // Check if directory exists
      if (!fs.existsSync(gitDir)) {
        throw new Error(`Directory does not exist: ${gitDir}`);
      }
      
      logInfo(`Working directory: ${gitDir}`);
      
      // Check if .git folder exists
      const gitFolderPath = path.join(gitDir, '.git');
      const gitExists = fs.existsSync(gitFolderPath);
      
      if (!gitExists) {
        logInfo("Git repository not found, initializing...");
        await execAsync(`cd "${gitDir}" && git init`);
        await execAsync(`cd "${gitDir}" && git remote add origin ${updateInfo.updateUrl} 2>/dev/null || git remote set-url origin ${updateInfo.updateUrl}`);
      } else {
        logInfo("Git repository found");
      }
      
      // Verify we're in the right git repo
      try {
        const { stdout } = await execAsync(`cd "${gitDir}" && git remote -v`);
        logInfo(`Git remotes: ${stdout}`);
      } catch (error) {
        logWarning("Could not fetch git remotes:", error.message);
      }
      
      try {
        // Ensure we're on the correct branch
        await execAsync(`cd "${gitDir}" && git checkout main 2>/dev/null || git checkout -b main`);
        
        // STASH LOCAL CHANGES FIRST
        logInfo("🛡️ Stashing local changes...");
        try {
          await execAsync(`cd "${gitDir}" && git stash`);
          logInfo("✅ Local changes stashed");
        } catch (stashError) {
          // If stash fails (no changes), that's okay
          logInfo("No local changes to stash");
        }
        
        // Fetch latest changes from origin
        logInfo("📥 Fetching latest changes from origin...");
        await execAsync(`cd "${gitDir}" && git fetch origin`);
        
        // Reset to origin/main
        logInfo("🔄 Resetting to origin/main...");
        await execAsync(`cd "${gitDir}" && git reset --hard origin/main`);
        
        // Apply stashed changes back if any
        try {
          await execAsync(`cd "${gitDir}" && git stash pop`);
          logInfo("✅ Stashed changes reapplied");
        } catch (popError) {
          // If no stashed changes, that's okay
          logInfo("No stashed changes to apply");
        }
        
        // If reset fails, try a different approach
      } catch (resetError) {
        logWarning("Standard reset failed, trying alternative approach:", resetError.message);
        
        // Alternative: Clean, stash, and pull
        try {
          await execAsync(`cd "${gitDir}" && git stash`);
        } catch (e) {
          logInfo("Could not stash changes");
        }
        
        await execAsync(`cd "${gitDir}" && git clean -fd`);
        await execAsync(`cd "${gitDir}" && git pull origin main --allow-unrelated-histories`);
        
        // Try to apply stash after pull
        try {
          await execAsync(`cd "${gitDir}" && git stash pop`);
        } catch (e) {
          logInfo("Could not apply stash after pull");
        }
      }
      
      // Verify the update worked by checking the current commit
      const { stdout: gitLog } = await execAsync(`cd "${gitDir}" && git log --oneline -1`);
      logInfo(`📝 Latest commit: ${gitLog.trim()}`);
      
      return true;
    } catch (error) {
      logError("❌ Git update failed:", error.message);
      
      // Provide helpful debugging info
      try {
        const { stdout: pwd } = await execAsync('pwd');
        logInfo(`Current working directory: ${pwd.trim()}`);
        
        const { stdout: ls } = await execAsync(`ls -la "${appDir}" 2>/dev/null || echo "Cannot list directory"`);
        logInfo(`Directory contents: ${ls}`);
        
        // Try to see git status for debugging
        try {
          const { stdout: gitStatus } = await execAsync(`cd "${appDir}" && git status --short`);
          logInfo(`Git status: ${gitStatus || 'Clean'}`);
        } catch (gitError) {
          logInfo("Could not get git status");
        }
      } catch (debugError) {
        logWarning("Debug info unavailable:", debugError.message);
      }
      
      return false;
    }
  }

  async installDependenciesAndSetup(appDir) {
    try {
      logInfo("📦 Installing Node.js dependencies...");
      
      // Install npm dependencies
      await execAsync(`cd "${appDir}" && npm install --production`);
      logSuccess("✅ Node.js dependencies installed");
      
      // Check if install_dependencies.sh exists
      const installScriptPath = path.join(appDir, 'install_dependencies.sh');
      if (fs.existsSync(installScriptPath)) {
        logInfo("🔧 Running install_dependencies.sh...");
        
        // Make the script executable WITH sudo
        await execAsync(`sudo chmod +x "${installScriptPath}"`);
        logSuccess("✅ Made install_dependencies.sh executable");
        
        // Run the script with sudo
        logInfo("🚀 Executing install_dependencies.sh with sudo...");
        await execAsync(`cd "${appDir}" && sudo ./install_dependencies.sh`);
        logSuccess("✅ Install dependencies script completed");
      } else {
        logInfo("⚠️ No install_dependencies.sh found, skipping");
      }
      
    } catch (error) {
      logError("❌ Dependencies installation failed:", error.message);
      throw error;
    }
  }

  async scheduleReboot() {
    try {
      logInfo("🔄 Scheduling Raspberry Pi reboot in 1 minute...");
      
      // Send notification before reboot
      this.publishUpdateStatus('reboot_scheduled', {
        message: 'System will reboot in 1 minute to complete update',
        timestamp: new Date().toISOString()
      });
      
      // Execute sudo reboot directly after 1 minute
      logInfo("⏰ Reboot scheduled in 1 minute...");
      await execAsync('sleep 60 && sudo reboot');
      logInfo("✅ Reboot command executed");
      
    } catch (error) {
      logError("❌ Failed to schedule reboot:", error.message);
      logInfo("⚠️ Manual reboot required after update");
      
      // Try alternative reboot methods
      try {
        logInfo("Trying alternative reboot method...");
        await execAsync('sudo shutdown -r +1 "System update completed, rebooting..."');
        logInfo("✅ Alternative reboot scheduled");
      } catch (altError) {
        logError("❌ All reboot methods failed:", altError.message);
      }
    }
  }

  async updateDeviceVersion(newVersion) {
    try {
      // Update device registration with new version using public endpoint
      await axios.post(`${SERVER_URL}/api/devices/register`, {
        rpi_id: RPI_ID,
        app_version: newVersion,
        last_seen: new Date().toISOString(),
        update_status: 'completed'
      }, {
        timeout: 10000,
        headers: {
          'User-Agent': `ADS-Display/${RPI_ID}`
        }
      });
      
      logInfo("✅ Device version updated on central server");
    } catch (error) {
      logWarning("⚠️ Could not update device version on server:", error.message);
    }
  }

  async createBackup(sourceDir, backupDir) {
    try {
      await execAsync(`mkdir -p "${backupDir}"`);
      await execAsync(`cp -r "${sourceDir}"/* "${backupDir}"/ 2>/dev/null || true`);
      logSuccess("✅ Backup created successfully");
    } catch (error) {
      logWarning("⚠️ Backup creation had issues:", error.message);
    }
  }

  async restoreBackup(sourceDir, backupDir) {
    logInfo("🔄 Restoring from backup...");
    try {
      await execAsync(`rm -rf "${sourceDir}"/* 2>/dev/null || true`);
      await execAsync(`cp -r "${backupDir}"/* "${sourceDir}"/ 2>/dev/null || true`);
      logSuccess("✅ Backup restored successfully");
    } catch (error) {
      logError("❌ Backup restore failed:", error.message);
    }
  }

  async cleanupBackup(backupDir) {
    try {
      await execAsync(`rm -rf "${backupDir}"`);
      logInfo("🧹 Backup cleaned up");
    } catch (error) {
      logWarning("⚠️ Backup cleanup failed:", error.message);
    }
  }

  async restartApplication() {
    logInfo("🔄 Restarting application...");

    const restartMethods = [
      () => execAsync("sudo pm2 restart ads-display 2>/dev/null"), // PM2 with sudo
      () => execAsync("sudo systemctl restart ads-display 2>/dev/null"), // Systemd with sudo
      () => this.killAndRestart() // Fallback
    ];

    for (const method of restartMethods) {
      try {
        await method();
        logSuccess("✅ Application restarted successfully");
        return;
      } catch (error) {
        logWarning(`⚠️ Restart method failed: ${error.message}`);
        continue;
      }
    }

    logError("❌ All restart methods failed");
  }

  async killAndRestart() {
    try {
      await execAsync("sudo pkill -f 'node server.js' 2>/dev/null || true");
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const appDir = process.cwd();
      await execAsync(`cd "${appDir}" && nohup node server.js > /var/log/ads-display/app.log 2>&1 &`);
    } catch (error) {
      throw new Error(`Kill and restart failed: ${error.message}`);
    }
  }

  // Manual update trigger
  async manualUpdate() {
    logInfo("🛠️ Manual update triggered");
    return await this.autoUpdate();
  }

  // MQTT status publishing
  publishUpdateStatus(status, data = {}) {
    if (mqttService && mqttService.connected) {
      try {
        mqttService.publishUpdateStatus(status, data);
      } catch (error) {
        logError("❌ Failed to publish MQTT update status:", error);
      }
    }
  }

  // API endpoint for manual update
  async updateViaAPI(req, res) {
    try {
      logInfo("📱 Manual update requested via API");
      
      const updateResult = await this.manualUpdate();
      
      if (updateResult) {
        res.json({
          success: true,
          message: "Update initiated successfully. System will reboot in 1 minute.",
          currentVersion: this.currentVersion
        });
      } else {
        res.status(500).json({
          success: false,
          message: "Update failed",
          currentVersion: this.currentVersion
        });
      }
    } catch (error) {
      logError("❌ API update error:", error);
      res.status(500).json({
        success: false,
        message: "Update failed: " + error.message
      });
    }
  }

  // Get update status
  getUpdateStatus(req, res) {
    res.json({
      success: true,
      currentVersion: this.currentVersion,
      updateAvailable: this.updateAvailable,
      lastChecked: this.lastChecked,
      checkInterval: this.checkInterval / 60000 // Convert to minutes
    });
  }
}

export const hybridUpdateService = new HybridUpdateService();