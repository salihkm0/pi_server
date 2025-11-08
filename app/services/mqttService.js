import mqtt from 'mqtt';
import { logInfo, logError, logSuccess, logWarning } from '../utils/logger.js';
import { MQTT_BROKER } from '../server.js';
import { hybridUpdateService } from './updateService.js';

class MQTTService {
  constructor(rpiId) {
    this.client = null;
    this.connected = false;
    this.rpiId = rpiId;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    
    this.topics = {
      commands: `ads-display/${this.rpiId}/commands`,
      status: `ads-display/${this.rpiId}/status`,
      updates: `ads-display/${this.rpiId}/updates`,
      broadcast: 'ads-display/all/commands'
    };
  }

  async connect() {
    // Don't attempt if broker is disabled
    if (MQTT_BROKER === 'disabled') {
      logInfo('MQTT is disabled in configuration');
      throw new Error('MQTT disabled');
    }

    return new Promise((resolve, reject) => {
      try {
        logInfo(`Connecting to MQTT broker: ${MQTT_BROKER}`);
        
        const options = {
          clientId: `ads-${this.rpiId}-${Date.now()}`,
          keepalive: 30,
          clean: true,
          connectTimeout: 10000,
          reconnectPeriod: 0, // We handle reconnection manually
        };

        this.client = mqtt.connect(MQTT_BROKER, options);

        this.client.on('connect', () => {
          this.connected = true;
          this.reconnectAttempts = 0;
          logSuccess('Connected to MQTT broker');
          this.subscribeToTopics();
          resolve();
        });

        this.client.on('message', (topic, message) => {
          this.handleMessage(topic, message.toString());
        });

        this.client.on('error', (error) => {
          logError('MQTT connection error:', error.message);
          if (!this.connected) {
            reject(error);
          }
        });

        this.client.on('close', () => {
          this.connected = false;
          logWarning('MQTT connection closed');
          this.attemptReconnect();
        });

        // Connection timeout
        setTimeout(() => {
          if (!this.connected) {
            this.client.end();
            reject(new Error('MQTT connection timeout'));
          }
        }, 15000);

      } catch (error) {
        logError('MQTT connection failed:', error);
        reject(error);
      }
    });
  }

  attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(2000 * this.reconnectAttempts, 10000);
      
      logInfo(`Attempting to reconnect in ${delay}ms... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      
      setTimeout(() => {
        if (this.client) {
          this.client.reconnect();
        }
      }, delay);
    } else {
      logError(`Max MQTT reconnect attempts reached. Giving up.`);
    }
  }

  subscribeToTopics() {
    if (!this.client || !this.connected) return;

    Object.values(this.topics).forEach(topic => {
      this.client.subscribe(topic, { qos: 0 }, (err) => {
        if (err) {
          logError(`Failed to subscribe to ${topic}:`, err);
        } else {
          logInfo(`Subscribed to MQTT topic: ${topic}`);
        }
      });
    });
  }

  handleMessage(topic, message) {
    try {
      const data = JSON.parse(message);
      logInfo(`MQTT message received on ${topic}`);

      switch (topic) {
        case this.topics.commands:
        case this.topics.broadcast:
          this.handleCommand(data);
          break;
        default:
          logInfo(`Received message on topic: ${topic}`);
      }
    } catch (error) {
      logError('Error handling MQTT message:', error);
    }
  }

  async handleCommand(command) {
    const { action, payload } = command;

    try {
      logInfo(`Executing MQTT command: ${action}`);
      
      switch (action) {
        case 'UPDATE':
          await hybridUpdateService.manualUpdate();
          break;

        case 'RESTART':
          logInfo('Restart command received via MQTT');
          this.publishStatus('restarting');
          setTimeout(() => {
            process.exit(0);
          }, 2000);
          break;

        case 'SYNC_VIDEOS':
          logInfo('Sync videos command received via MQTT');
          // Implement video sync trigger
          break;

        case 'GET_STATUS':
          this.publishFullStatus();
          break;

        case 'PING':
          this.publishStatus('online', { ping: 'pong' });
          break;

        default:
          logWarning(`Unknown MQTT command: ${action}`);
      }
    } catch (error) {
      logError(`MQTT command failed: ${action}`, error);
      this.publishStatus('error', { 
        action, 
        error: error.message 
      });
    }
  }

  publishStatus(status, data = {}) {
    if (this.connected && this.client) {
      try {
        const message = JSON.stringify({
          deviceId: this.rpiId,
          status,
          timestamp: new Date().toISOString(),
          ...data
        });

        this.client.publish(this.topics.status, message, { qos: 0 });
      } catch (error) {
        logError('Error publishing status:', error);
      }
    }
  }

  publishFullStatus() {
    if (this.connected && this.client) {
      try {
        const status = {
          deviceId: this.rpiId,
          version: hybridUpdateService.currentVersion,
          uptime: process.uptime(),
          updateAvailable: hybridUpdateService.updateAvailable,
          lastChecked: hybridUpdateService.lastChecked,
          timestamp: new Date().toISOString()
        };

        this.client.publish(this.topics.status, JSON.stringify(status), { qos: 0 });
      } catch (error) {
        logError('Error publishing full status:', error);
      }
    }
  }

  async disconnect() {
    if (this.client) {
      logInfo('Disconnecting from MQTT broker...');
      this.publishStatus('offline');
      
      return new Promise((resolve) => {
        this.client.end(false, {}, () => {
          this.connected = false;
          logInfo('MQTT disconnected gracefully');
          resolve();
        });
      });
    }
  }

  // Utility method to check connection status
  isConnected() {
    return this.connected && this.client && this.client.connected;
  }
}

export { MQTTService };