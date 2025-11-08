import { exec } from "child_process";
import { promisify } from "util";
import axios from "axios";
import fs from "fs";
import { logInfo, logError, logSuccess } from "../utils/logger.js";

const execAsync = promisify(exec);

class HybridUpdateService {
  constructor() {
    this.updateStrategies = [
      'git',
      'rsync', 
      'docker',
      'package'
    ];
  }

  async autoUpdate() {
    for (const strategy of this.updateStrategies) {
      try {
        logInfo(`Trying update strategy: ${strategy}`);
        
        const success = await this.executeStrategy(strategy);
        if (success) {
          logSuccess(`Update successful using ${strategy} strategy`);
          return true;
        }
      } catch (error) {
        logError(`${strategy} strategy failed:`, error.message);
        continue;
      }
    }
    
    logError('All update strategies failed');
    return false;
  }

  async executeStrategy(strategy) {
    switch (strategy) {
      case 'git':
        return await this.gitUpdate();
      case 'rsync':
        return await this.rsyncUpdate();
      case 'docker':
        return await this.dockerUpdate();
      case 'package':
        return await this.packageUpdate();
      default:
        return false;
    }
  }

  async gitUpdate() {
    // Your existing git-based update logic
    await execAsync('git fetch origin');
    await execAsync('git reset --hard origin/main');
    await execAsync('npm install');
    return true;
  }

  async rsyncUpdate() {
    // Rsync from central server
    await execAsync('rsync -avz user@server.com:/apps/ads-display/ /home/pi/ads-display/');
    await execAsync('npm install');
    return true;
  }

  async dockerUpdate() {
    // Docker-based update
    await execAsync('docker-compose pull');
    await execAsync('docker-compose down');
    await execAsync('docker-compose up -d');
    return true;
  }

  async packageUpdate() {
    // Debian package update
    await execAsync('wget https://server.com/ads-display-latest.deb -O /tmp/ads-display.deb');
    await execAsync('sudo dpkg -i /tmp/ads-display.deb');
    return true;
  }
}

export const hybridUpdateService = new HybridUpdateService();