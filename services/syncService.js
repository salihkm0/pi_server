import { logInfo, logError, logWarning, logSuccess } from '../utils/logger.js';
import { 
  fetchVideosList, 
  downloadAllVideos, 
  getLocalVideosInfo, 
  checkServerAccessibility, 
  reportDownloadIssue,
  checkPartialDownloads,
  cleanupPartialDownloads,
  isInternetConnected
} from './videoService.js';
import fs from 'fs';
import path from 'path';
import { VIDEOS_DIR } from '../server.js';

export class SyncService {
  constructor() {
    this.isSyncing = false;
    this.lastSync = null;
    this.lastSuccessfulSync = null;
    this.syncStats = {
      totalSyncs: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      skippedSyncs: 0,
      totalVideosDownloaded: 0,
      totalVideosDeleted: 0,
      totalVideosResumed: 0
    };
  }

  async syncVideos() {
    if (this.isSyncing) {
      logWarning('Sync already in progress, skipping...');
      return {
        success: false,
        message: 'Sync already in progress',
        skipped: true
      };
    }

    // Check internet connection before starting sync
    if (!await isInternetConnected()) {
      logWarning('🌐 No internet connection - skipping sync entirely');
      this.syncStats.skippedSyncs++;
      return {
        success: false,
        message: 'No internet connection - sync skipped',
        skipped: true,
        internetAvailable: false
      };
    }

    this.isSyncing = true;
    this.lastSync = new Date().toISOString();
    
    try {
      logInfo('🔄 Starting video synchronization...');

      // Check if server is accessible first
      const serverAccessible = await checkServerAccessibility();
      if (!serverAccessible) {
        throw new Error('Server is not accessible');
      }

      // Check for partial downloads that can be resumed
      const partialDownloads = await checkPartialDownloads();
      if (partialDownloads.length > 0) {
        logInfo(`📥 Found ${partialDownloads.length} partial downloads that will be resumed`);
      }

      // Fetch videos list from server
      const serverVideos = await fetchVideosList();
      if (!serverVideos || serverVideos.length === 0) {
        logWarning('No videos available on server');
        return { 
          downloaded: 0, 
          deleted: 0, 
          error: 'No videos on server',
          success: true 
        };
      }

      // Get local videos (including partial downloads)
      const localVideos = getLocalVideosInfo();
      
      // Determine which videos to download and delete
      const { toDownload, toDelete } = this.compareVideos(serverVideos, localVideos);

      logInfo(`📊 Changes detected: ${toDownload.length} to download, ${toDelete.length} to delete`);

      // Download new videos
      let downloadResult = { 
        successCount: 0, 
        failCount: 0, 
        failedVideos: [],
        resumeableCount: 0,
        permanentFailCount: 0
      };
      
      if (toDownload.length > 0) {
        downloadResult = await downloadAllVideos(toDownload);
        
        // Update resume statistics
        this.syncStats.totalVideosResumed += downloadResult.resumeableCount || 0;
        
        // Only report permanent failures (not internet-related ones)
        for (const failed of downloadResult.failedVideos) {
          if (!failed.canResume && !failed.error.includes('internet')) {
            await reportDownloadIssue(failed.filename, failed.error, failed.url);
          }
        }
      }

      // Delete removed videos (but keep partial downloads for resume)
      let deletedCount = 0;
      for (const video of toDelete) {
        try {
          const filePath = path.join(VIDEOS_DIR, video.filename);
          const tempPath = `${filePath}.download`;
          
          // Delete final file if it exists
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            logInfo(`🗑️ Deleted video: ${video.filename}`);
            deletedCount++;
          }
          
          // Also delete partial download if it exists
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
            logInfo(`🗑️ Deleted partial download: ${video.filename}`);
          }
        } catch (error) {
          logError(`Error deleting ${video.filename}:`, error.message);
        }
      }

      // Update sync statistics
      this.syncStats.totalSyncs++;
      if (downloadResult.failCount === 0 || (downloadResult.resumeableCount === downloadResult.failCount && downloadResult.permanentFailCount === 0)) {
        this.syncStats.successfulSyncs++;
        this.lastSuccessfulSync = new Date().toISOString();
      } else {
        this.syncStats.failedSyncs++;
      }
      this.syncStats.totalVideosDownloaded += downloadResult.successCount;
      this.syncStats.totalVideosDeleted += deletedCount;

      const result = {
        downloaded: downloadResult.successCount,
        failed: downloadResult.failCount,
        deleted: deletedCount,
        resumed: downloadResult.resumeableCount || 0,
        total: serverVideos.length,
        success: downloadResult.permanentFailCount === 0, // Success if no permanent failures
        message: this.generateSyncMessage(downloadResult),
        internetAvailable: true
      };

      if (result.success) {
        logSuccess(`✅ Sync completed. Downloaded: ${result.downloaded}, Resumed: ${result.resumed}, Deleted: ${result.deleted}`);
      } else {
        logWarning(`⚠️ Sync completed with ${result.failed} errors. Successful: ${result.downloaded}, Resumed: ${result.resumed}, Failed: ${result.failed}, Deleted: ${result.deleted}`);
      }

      return result;

    } catch (error) {
      this.syncStats.totalSyncs++;
      this.syncStats.failedSyncs++;
      
      logError('❌ Video synchronization failed:', error.message);
      
      // Don't throw error to prevent crashing the application
      return {
        success: false,
        error: error.message,
        downloaded: 0,
        deleted: 0,
        failed: 0,
        resumed: 0,
        internetAvailable: await isInternetConnected()
      };
    } finally {
      this.isSyncing = false;
    }
  }

  generateSyncMessage(downloadResult) {
    const { successCount, failCount, resumeableCount, permanentFailCount, skipped } = downloadResult;
    
    if (skipped) {
      return 'Sync skipped - no internet connection';
    } else if (failCount === 0) {
      return 'Sync completed successfully';
    } else if (resumeableCount > 0 && permanentFailCount === 0) {
      return `Sync completed with ${resumeableCount} downloads paused (will resume)`;
    } else if (permanentFailCount > 0) {
      return `Sync completed with ${permanentFailCount} permanent failures`;
    } else {
      return `Sync completed with ${failCount} errors`;
    }
  }

  compareVideos(serverVideos, localVideos) {
    const serverFilenames = serverVideos.map(v => 
      v.filename.endsWith('.mp4') ? v.filename : `${v.filename}.mp4`
    );
    const localFilenames = localVideos.map(v => v.filename);

    // Videos to download: on server but not locally (or partial downloads)
    const toDownload = serverVideos.filter(serverVideo => {
      const filename = serverVideo.filename.endsWith('.mp4') 
        ? serverVideo.filename 
        : `${serverVideo.filename}.mp4`;
      
      const localVideo = localVideos.find(local => local.filename === filename);
      
      // Download if file doesn't exist locally OR exists but is partial
      return !localVideo || localVideo.status === 'partial';
    });

    // Videos to delete: locally but not on server (only complete files)
    const toDelete = localVideos.filter(localVideo => 
      !serverFilenames.includes(localVideo.filename) && localVideo.status === 'complete'
    );

    return { toDownload, toDelete };
  }

  // Get sync status
  getStatus() {
    const localVideos = getLocalVideosInfo();
    const completeVideos = localVideos.filter(v => v.status === 'complete');
    const partialVideos = localVideos.filter(v => v.status === 'partial');
    
    return {
      isSyncing: this.isSyncing,
      lastSync: this.lastSync,
      lastSuccessfulSync: this.lastSuccessfulSync,
      localVideos: completeVideos.length,
      partialVideos: partialVideos.length,
      stats: this.syncStats,
      internetAvailable: false // Will be checked in real-time
    };
  }

  // Force sync regardless of current state
  async forceSync() {
    logInfo('🔧 Force sync requested');
    if (this.isSyncing) {
      logWarning('Sync in progress, cannot force sync');
      return { success: false, message: 'Sync already in progress' };
    }
    
    return await this.syncVideos();
  }

  // Clean up all partial downloads
  async cleanupPartialDownloads() {
    logInfo('🧹 Cleaning up all partial downloads');
    await cleanupPartialDownloads();
    return { success: true, message: 'Partial downloads cleaned up' };
  }

  // Get sync statistics
  getStatistics() {
    const localVideos = getLocalVideosInfo();
    const partialVideos = localVideos.filter(v => v.status === 'partial');
    
    return {
      ...this.syncStats,
      lastSync: this.lastSync,
      lastSuccessfulSync: this.lastSuccessfulSync,
      isSyncing: this.isSyncing,
      partialDownloads: partialVideos.length,
      uptime: process.uptime()
    };
  }

  // Check if sync is possible (has internet)
  async canSync() {
    return await isInternetConnected();
  }
}

export const syncService = new SyncService();