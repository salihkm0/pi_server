import { logInfo, logError, logWarning } from '../utils/logger.js';
import { mqttService } from '../server.js';
import { getSystemInfo } from '../utils/systemInfo.js';
import { configManager } from './configManager.js';
import { updateDeviceStatus } from './deviceRegistration.js';
import { wifiManager } from './wifiManager.js';

class HealthMonitor {
  constructor() {
    this.isMonitoring = false;
    this.interval = null;
    this.checkInterval = 300000; // 5 minutes
  }

  start() {
    if (this.isMonitoring) {
      logWarning('Health monitoring is already running');
      return;
    }

    this.isMonitoring = true;
    this.interval = setInterval(() => {
      this.collectAndReport();
    }, this.checkInterval);

    // Initial health report
    setTimeout(() => {
      this.collectAndReport();
    }, 5000);

    logInfo('Health monitoring started');
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isMonitoring = false;
    logInfo('Health monitoring stopped');
  }

  async collectAndReport() {
    try {
      const healthData = await this.collectHealthData();
      await this.reportToCentralServer(healthData);
      await this.publishHealthMetrics(healthData);
      
      logInfo('Health report completed successfully');
    } catch (error) {
      logError('Health monitoring failed:', error);
    }
  }

  async collectHealthData() {
    const systemInfo = await getSystemInfo();
    const config = await configManager.loadConfig();
    const wifiStatus = await wifiManager.getCurrentWifi();

    return {
      deviceId: config.deviceId,
      username: config.username,
      timestamp: new Date().toISOString(),
      status: 'healthy',
      version: config.version,
      uptime: process.uptime(),
      system: {
        cpu: await this.getCpuUsage(),
        memory: await this.getMemoryUsage(),
        disk: await this.getDiskUsage(),
        temperature: await this.getTemperature()
      },
      wifi: wifiStatus,
      services: {
        videoPlayer: this.isVideoPlayerRunning(),
        syncService: true,
        updateService: true,
        mqtt: mqttService ? mqttService.connected : false
      },
      network: {
        online: await wifiManager.testInternet(),
        interfaces: systemInfo.network_interfaces
      }
    };
  }

  async getCpuUsage() {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      const { stdout } = await execAsync("top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'");
      return parseFloat(stdout.trim());
    } catch (error) {
      return 0;
    }
  }

  async getMemoryUsage() {
    try {
      const os = await import('os');
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      return Math.round(((totalMem - freeMem) / totalMem) * 100);
    } catch (error) {
      return 0;
    }
  }

  async getDiskUsage() {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      const { stdout } = await execAsync("df / | awk 'NR==2 {print $5}' | sed 's/%//'");
      return parseInt(stdout.trim());
    } catch (error) {
      return 0;
    }
  }

  async getTemperature() {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      const { stdout } = await execAsync("vcgencmd measure_temp | cut -d'=' -f2 | cut -d\"'\" -f1");
      return parseFloat(stdout.trim());
    } catch (error) {
      return 0;
    }
  }

  isVideoPlayerRunning() {
    try {
      const { execSync } = require('child_process');
      const result = execSync('pgrep -f mpv').toString().trim();
      return result.length > 0;
    } catch (error) {
      return false;
    }
  }

  async reportToCentralServer(healthData) {
    try {
      // Update device status with health data
      await updateDeviceStatus("active", healthData.system);
      logInfo('Health report sent to central server');
      return true;
    } catch (error) {
      logError('Failed to report health to central server:', error);
      throw error;
    }
  }

  async publishHealthMetrics(healthData) {
    try {
      // Only publish if MQTT is available and connected
      if (mqttService && mqttService.connected) {
        mqttService.publishStatus('healthy', {
          system: healthData.system,
          wifi: healthData.wifi,
          uptime: healthData.uptime
        });
        logInfo('Health metrics published via MQTT');
      } else {
        logInfo('MQTT not available, skipping health metrics publication');
      }
    } catch (error) {
      logError('Failed to publish health metrics:', error);
      // Don't throw error here as it's not critical
    }
  }
}

export const healthMonitor = new HealthMonitor();
export const startHealthMonitoring = () => healthMonitor.start();