import WebSocket from 'ws';
import { autoUpdate } from './updateService.js';
import { logInfo, logError } from '../utils/logger.js';
import { RPI_ID } from '../server.js';

class WebSocketUpdateService {
  constructor() {
    this.ws = null;
    this.serverUrl = 'wss://your-server.com/updates';
    this.reconnectInterval = 5000;
  }

  connect() {
    try {
      this.ws = new WebSocket(this.serverUrl, {
        headers: {
          'Device-ID': RPI_ID,
          'Authorization': 'Bearer your-token'
        }
      });

      this.ws.on('open', () => {
        logInfo('WebSocket connected to update server');
        this.sendHeartbeat();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(JSON.parse(data));
      });

      this.ws.on('close', () => {
        logInfo('WebSocket disconnected, reconnecting...');
        setTimeout(() => this.connect(), this.reconnectInterval);
      });

      this.ws.on('error', (error) => {
        logError('WebSocket error:', error);
      });

    } catch (error) {
      logError('WebSocket connection failed:', error);
    }
  }

  handleMessage(message) {
    const { type, payload } = message;

    switch (type) {
      case 'UPDATE_COMMAND':
        this.handleUpdateCommand(payload);
        break;
      case 'RESTART_COMMAND':
        this.handleRestartCommand(payload);
        break;
      case 'CONFIG_UPDATE':
        this.handleConfigUpdate(payload);
        break;
    }
  }

  async handleUpdateCommand(payload) {
    logInfo('Received update command via WebSocket');
    
    this.sendStatus('UPDATE_STARTED');
    
    try {
      await autoUpdate();
      this.sendStatus('UPDATE_COMPLETED');
    } catch (error) {
      this.sendStatus('UPDATE_FAILED', { error: error.message });
    }
  }

  sendStatus(status, data = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'STATUS_UPDATE',
        payload: {
          deviceId: RPI_ID,
          status,
          timestamp: new Date().toISOString(),
          ...data
        }
      }));
    }
  }

  sendHeartbeat() {
    setInterval(() => {
      this.sendStatus('HEARTBEAT', {
        version: require('../package.json').version,
        uptime: process.uptime()
      });
    }, 30000);
  }
}

export const websocketUpdateService = new WebSocketUpdateService();