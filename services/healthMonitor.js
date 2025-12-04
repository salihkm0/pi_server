import { logInfo, logError, logSuccess, logWarning } from "../utils/logger.js";
import { getSystemInfo } from "../utils/systemInfo.js";
import { isInternetConnected } from "./videoService.js";
import { wifiManager } from "./wifiManager.js";
import { syncService } from "./syncService.js";
import { mqttService } from "../server.js";
import { configManager } from "./configManager.js";
import fs from "fs";
import os from "os";
import { VIDEOS_DIR } from "../server.js";

export class HealthMonitor {
  constructor() {
    this.interval = null;
    this.reportInterval = 5 * 60 * 1000; // 5 minutes
    this.isMonitoring = false;
    this.lastReportTime = null;
    this.serverUrl = process.env.SERVER_URL || "https://pi-central-server.onrender.com";
  }

  // Start health monitoring
  start() {
    if (this.isMonitoring) {
      logWarning("Health monitoring is already running");
      return;
    }

    logInfo("🩺 Starting health monitoring service");
    this.isMonitoring = true;

    // Send initial report
    setTimeout(() => {
      this.sendHealthReport();
    }, 30000); // Wait 30 seconds after startup

    // Schedule periodic reports
    this.interval = setInterval(() => {
      this.sendHealthReport();
    }, this.reportInterval);

    logSuccess(`✅ Health monitoring started (reports every ${this.reportInterval / 60000} minutes)`);
  }

  // Stop health monitoring
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isMonitoring = false;
    logInfo("🛑 Health monitoring stopped");
  }

  // Collect health metrics
  async collectMetrics() {
    try {
      const systemInfo = await getSystemInfo();
      const internetStatus = await isInternetConnected();
      const wifiStatus = await wifiManager.getCurrentWifi();
      const syncStatus = syncService.getStatus();
      
      // Get CPU usage
      const cpuUsage = await this.getCpuUsage();
      
      // Get memory usage
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const memoryUsage = ((totalMem - freeMem) / totalMem) * 100;
      
      // Get disk usage
      const diskUsage = await this.getDiskUsage();
      
      // Get video count
      const videoCount = await this.getVideoCount();
      
      // Get system uptime
      const uptime = process.uptime();
      
      // Get temperature (if available)
      const temperature = await this.getTemperature();

      const metrics = {
        cpu_usage: Math.round(cpuUsage),
        memory_usage: Math.round(memoryUsage),
        disk_usage: Math.round(diskUsage),
        temperature: temperature ? Math.round(temperature) : null,
        network_status: internetStatus ? "online" : "offline",
        video_count: videoCount,
        uptime: Math.round(uptime),
        mqtt_connected: mqttService ? mqttService.connected : false,
        last_sync: syncStatus.lastSync || new Date().toISOString(),
        wifi_status: wifiStatus.connected ? "connected" : "disconnected",
        wifi_ssid: wifiStatus.connected ? wifiStatus.ssid : null,
        wifi_signal: wifiStatus.signal || 0,
        internet_status: internetStatus
      };

      return {
        device_id: configManager.get("deviceId"),
        metrics: metrics,
        timestamp: new Date().toISOString(),
        wifi_status: wifiStatus,
        internet_status: internetStatus
      };

    } catch (error) {
      logError("Error collecting health metrics:", error);
      return null;
    }
  }

  // Get CPU usage percentage
  async getCpuUsage() {
    try {
      const cpus = os.cpus();
      let totalIdle = 0;
      let totalTick = 0;

      cpus.forEach(cpu => {
        for (let type in cpu.times) {
          totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
      });

      return 100 - (100 * totalIdle / totalTick);
    } catch (error) {
      logError("Error getting CPU usage:", error);
      return 0;
    }
  }

  // Get disk usage percentage
  async getDiskUsage() {
    try {
      const stats = fs.statfsSync("/");
      const total = stats.blocks * stats.bsize;
      const free = stats.bfree * stats.bsize;
      const used = total - free;
      return (used / total) * 100;
    } catch (error) {
      try {
        // Try alternative method for different OS
        const { exec } = await import("child_process");
        const { promisify } = await import("util");
        const execAsync = promisify(exec);
        
        if (process.platform === 'linux') {
          const { stdout } = await execAsync("df / --output=pcent | tail -1 | tr -d '% '");
          return parseFloat(stdout.trim());
        } else if (process.platform === 'darwin') {
          const { stdout } = await execAsync("df / | tail -1 | awk '{print $5}' | tr -d '%'");
          return parseFloat(stdout.trim());
        }
      } catch (e) {
        logError("Error getting disk usage:", e);
      }
      return 0;
    }
  }

  // Get video count
  async getVideoCount() {
    try {
      if (!fs.existsSync(VIDEOS_DIR)) {
        return 0;
      }
      const files = fs.readdirSync(VIDEOS_DIR);
      const videoFiles = files.filter(file => 
        file.endsWith('.mp4') || 
        file.endsWith('.MP4') || 
        file.endsWith('.mov') || 
        file.endsWith('.MOV')
      );
      return videoFiles.length;
    } catch (error) {
      logError("Error getting video count:", error);
      return 0;
    }
  }

  // Get temperature (for Raspberry Pi)
  async getTemperature() {
    try {
      if (process.platform === 'linux') {
        const fs = await import("fs");
        const temp = fs.readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8");
        return parseFloat(temp) / 1000; // Convert millidegrees to degrees
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  // Send health report to central server
  async sendHealthReport() {
    try {
      const healthData = await this.collectMetrics();
      
      if (!healthData) {
        logError("Failed to collect health metrics");
        return;
      }

      logInfo("📊 Sending health report to central server...");
      
      const axios = await import("axios");
      
      const payload = {
        device_id: healthData.device_id,
        metrics: healthData.metrics,
        timestamp: healthData.timestamp,
        wifi_status: healthData.wifi_status,
        internet_status: healthData.internet_status
      };

      // Try multiple endpoints
      const endpoints = [
        `${this.serverUrl}/api/devices/health`,
        `${this.serverUrl}/api/rpi/health`
      ];

      let reportSent = false;
      let lastError = null;

      for (const endpoint of endpoints) {
        try {
          const response = await axios.default.post(endpoint, payload, {
            timeout: 10000,
            headers: {
              'User-Agent': `ADS-Display/${healthData.device_id}`,
              'Content-Type': 'application/json'
            }
          });

          if (response.status === 200) {
            this.lastReportTime = new Date();
            logSuccess(`✅ Health report sent successfully to ${endpoint}`);
            reportSent = true;
            
            // Publish via MQTT if available
            if (mqttService && mqttService.connected) {
              await this.publishHealthMetrics(healthData);
            }
            
            break;
          }
        } catch (error) {
          lastError = error;
          logWarning(`❌ Failed to send health report to ${endpoint}: ${error.message}`);
          continue;
        }
      }

      if (!reportSent) {
        logError(`❌ All health report endpoints failed. Last error: ${lastError?.message}`);
      }

    } catch (error) {
      logError("❌ Error sending health report:", error);
    }
  }

  // Publish health metrics via MQTT
  async publishHealthMetrics(healthData) {
    try {
      if (!mqttService || !mqttService.connected) {
        return;
      }

      const mqttPayload = {
        deviceId: healthData.device_id,
        timestamp: healthData.timestamp,
        metrics: healthData.metrics,
        status: "active"
      };

      await mqttService.publishHealth(mqttPayload);
      logInfo("📡 Health metrics published via MQTT");

    } catch (error) {
      logError("❌ Error publishing health metrics via MQTT:", error);
    }
  }

  // Get monitoring status
  getStatus() {
    return {
      isMonitoring: this.isMonitoring,
      reportInterval: this.reportInterval,
      lastReportTime: this.lastReportTime,
      nextReportIn: this.lastReportTime ? 
        this.reportInterval - (Date.now() - this.lastReportTime.getTime()) : 
        "unknown"
    };
  }
}

// Create singleton instance
export const healthMonitor = new HealthMonitor();

// Export start function
export const startHealthMonitoring = () => {
  healthMonitor.start();
};