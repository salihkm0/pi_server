import mqtt from 'mqtt';
import { autoUpdate } from './updateService.js';
import { logInfo, logError } from '../utils/logger.js';
import { RPI_ID } from '../server.js';

class MQTTUpdateService {
  constructor() {
    this.client = null;
    this.brokerUrl = 'mqtt://your-mqtt-broker.com';
    this.topicBase = 'ads-display/';
  }

  async connect() {
    try {
      this.client = mqtt.connect(this.brokerUrl, {
        clientId: RPI_ID,
        username: 'pi',
        password: 'password'
      });

      this.client.on('connect', () => {
        logInfo('Connected to MQTT broker');
        this.subscribeToTopics();
      });

      this.client.on('message', (topic, message) => {
        this.handleMessage(topic, message.toString());
      });

      this.client.on('error', (error) => {
        logError('MQTT error:', error);
      });

    } catch (error) {
      logError('MQTT connection failed:', error);
    }
  }

  subscribeToTopics() {
    const topics = [
      `${this.topicBase}${RPI_ID}/update`,
      `${this.topicBase}all/update`,
      `${this.topicBase}group/update`
    ];

    topics.forEach(topic => {
      this.client.subscribe(topic, (err) => {
        if (err) {
          logError(`Failed to subscribe to ${topic}:`, err);
        } else {
          logInfo(`Subscribed to ${topic}`);
        }
      });
    });
  }

  handleMessage(topic, message) {
    try {
      const data = JSON.parse(message);
      
      switch (topic.split('/').pop()) {
        case 'update':
          this.handleUpdateCommand(data);
          break;
        case 'restart':
          this.handleRestartCommand(data);
          break;
        case 'config':
          this.handleConfigUpdate(data);
          break;
      }
    } catch (error) {
      logError('Error handling MQTT message:', error);
    }
  }

  async handleUpdateCommand(data) {
    logInfo('Received update command via MQTT');
    
    try {
      await autoUpdate();
      this.publishStatus('update_completed', { success: true });
    } catch (error) {
      this.publishStatus('update_failed', { error: error.message });
    }
  }

  publishStatus(status, data) {
    const topic = `${this.topicBase}${RPI_ID}/status`;
    const message = JSON.stringify({
      status,
      deviceId: RPI_ID,
      timestamp: new Date().toISOString(),
      ...data
    });

    this.client.publish(topic, message);
  }
}

export const mqttUpdateService = new MQTTUpdateService();