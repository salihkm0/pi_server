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
      const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      return packageJson.version || "1.0.0";
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
      // This doesn't return version info, but ensures server is reachable
      const response = await axios.get(`${SERVER_URL}/api/health`, {
        timeout: 10000,
        headers: {
          'User-Agent': `ADS-Display/${RPI_ID}`
        }
      });
      
      // If server is reachable but we don't have version info from server,
      // we'll rely on GitHub for version checks
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
      // Simple version file check - create a public version endpoint on your server if needed
      // For now, just return current version
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

    const appDir = path.join(__dirname, '..', '..');
    const backupDir = `/tmp/ads-display-backup-${Date.now()}`;
    
    try {
      logInfo("🚀 Starting update process...");
      this.publishUpdateStatus('update_started', updateInfo);

      // Step 1: Create backup
      logInfo("📦 Creating backup...");
      await this.createBackup(appDir, backupDir);

      // Step 2: Execute Git update
      const updateSuccess = await this.gitUpdate(appDir, updateInfo);

      if (!updateSuccess) {
        throw new Error('Git update failed');
      }

      // Step 3: Verify update
      const newVersion = this.getCurrentVersion();
      if (newVersion !== updateInfo.latestVersion) {
        throw new Error(`Version mismatch after update. Expected: ${updateInfo.latestVersion}, Got: ${newVersion}`);
      }

      // Step 4: Update device registration with new version
      await this.updateDeviceVersion(newVersion);

      // Step 5: Notify success
      this.publishUpdateStatus('update_completed', {
        fromVersion: this.currentVersion,
        toVersion: updateInfo.latestVersion
      });

      logSuccess(`✅ Update successful! Version: ${newVersion}`);

      // Step 6: Restart application (optional - comment out for testing)
      logInfo("Update completed. Manual restart may be required.");
      // await this.restartApplication();

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
      // Check if git repository exists
      await execAsync(`cd "${appDir}" && git status`);
      logInfo("Git repository found, pulling latest changes...");
    } catch (error) {
      logInfo("Initializing git repository...");
      await execAsync(`cd "${appDir}" && git init`);
      await execAsync(`cd "${appDir}" && git remote add origin ${updateInfo.updateUrl}`);
    }

    try {
      // Fetch and reset to latest
      await execAsync(`cd "${appDir}" && git fetch origin`);
      await execAsync(`cd "${appDir}" && git reset --hard origin/main`);
      
      // Install dependencies
      await execAsync(`cd "${appDir}" && npm install --production`);
      
      return true;
    } catch (error) {
      logError("Git update failed:", error.message);
      return false;
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
      
      logInfo("Device version updated on central server");
    } catch (error) {
      logWarning("Could not update device version on server:", error.message);
    }
  }

  async createBackup(sourceDir, backupDir) {
    try {
      await execAsync(`mkdir -p "${backupDir}"`);
      await execAsync(`cp -r "${sourceDir}"/* "${backupDir}"/ 2>/dev/null || true`);
      logSuccess("Backup created successfully");
    } catch (error) {
      logWarning("Backup creation had issues:", error.message);
    }
  }

  async restoreBackup(sourceDir, backupDir) {
    logInfo("🔄 Restoring from backup...");
    try {
      await execAsync(`rm -rf "${sourceDir}"/* 2>/dev/null || true`);
      await execAsync(`cp -r "${backupDir}"/* "${sourceDir}"/ 2>/dev/null || true`);
      await execAsync(`cd "${sourceDir}" && npm install --production`);
      logSuccess("Backup restored successfully");
    } catch (error) {
      logError("Backup restore failed:", error.message);
    }
  }

  async cleanupBackup(backupDir) {
    try {
      await execAsync(`rm -rf "${backupDir}"`);
    } catch (error) {
      logWarning("Backup cleanup failed:", error.message);
    }
  }

  async restartApplication() {
    logInfo("🔄 Restarting application...");

    const restartMethods = [
      () => execAsync("pm2 restart ads-display"), // PM2
      () => execAsync("sudo systemctl restart ads-display"), // Systemd
      () => this.killAndRestart() // Fallback
    ];

    for (const method of restartMethods) {
      try {
        await method();
        logSuccess("Application restarted successfully");
        return;
      } catch (error) {
        logWarning(`Restart method failed: ${error.message}`);
        continue;
      }
    }

    throw new Error("All restart methods failed");
  }

  async killAndRestart() {
    try {
      await execAsync("pkill -f 'node server.js'");
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const appDir = path.join(__dirname, '..', '..');
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
        logError("Failed to publish MQTT update status:", error);
      }
    }
  }
}

export const hybridUpdateService = new HybridUpdateService();