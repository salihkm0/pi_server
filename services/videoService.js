import fs from "fs";
import path from "path";
import axios from "axios";
import { logError, logInfo, logSuccess, logWarning } from "../utils/logger.js";
import { SERVER_URL, VIDEOS_DIR, RPI_ID } from "../server.js";
import clc from "cli-color";

// Enhanced internet check function
export const isInternetConnected = async () => {
  const testEndpoints = [
    'https://www.google.com',
    'https://www.cloudflare.com',
    'https://www.apple.com',
    SERVER_URL // Also test our own server
  ];

  for (const endpoint of testEndpoints) {
    try {
      await axios.get(endpoint, { 
        timeout: 10000,
        headers: {
          'User-Agent': `ADS-Display/${RPI_ID}`
        }
      });
      logSuccess(`🌐 Internet connectivity confirmed via ${endpoint}`);
      return true;
    } catch (error) {
      logWarning(`🌐 Cannot reach ${endpoint}: ${error.message}`);
      continue;
    }
  }

  logError('🌐 No internet connection available');
  return false;
};

export const downloadVideo = async (video, attempt = 1) => {
  const maxRetries = 5;
  const filenameWithExt = video.filename.endsWith(".mp4")
    ? video.filename
    : `${video.filename}.mp4`;
  const localPath = path.join(VIDEOS_DIR, filenameWithExt);
  const tempPath = `${localPath}.download`;
  
  let startByte = 0;
  let fileSize = 0;

  // Check internet before starting download
  if (!await isInternetConnected()) {
    throw new Error('No internet connection - skipping download');
  }

  // Check if we have a partial download to resume
  if (fs.existsSync(tempPath)) {
    const stats = fs.statSync(tempPath);
    startByte = stats.size;
    logInfo(`Resuming download from ${startByte} bytes: ${filenameWithExt}`);
  }

  // Check if file already exists completely
  if (fs.existsSync(localPath) && !fs.existsSync(tempPath)) {
    const stats = fs.statSync(localPath);
    if (stats.size > 0) {
      logInfo(`Video already exists: ${filenameWithExt} (${stats.size} bytes)`);
      return { success: true, filename: filenameWithExt, size: stats.size };
    } else {
      // Delete empty/corrupted file
      fs.unlinkSync(localPath);
    }
  }

  try {
    logInfo(`Downloading: ${filenameWithExt} (attempt ${attempt}/${maxRetries})`);

    // Get file size first for progress tracking
    if (startByte === 0) {
      try {
        const headResponse = await axios.head(video.fileUrl, {
          timeout: 10000,
          headers: {
            'User-Agent': `ADS-Display/${RPI_ID}`,
            'Range': 'bytes=0-0'
          }
        });
        
        const contentRange = headResponse.headers['content-range'];
        if (contentRange) {
          fileSize = parseInt(contentRange.split('/')[1]);
        } else {
          fileSize = parseInt(headResponse.headers['content-length']) || 0;
        }
        
        if (fileSize > 0) {
          logInfo(`Total file size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);
        }
      } catch (error) {
        logWarning(`Could not get file size: ${error.message}`);
      }
    }

    const writer = fs.createWriteStream(tempPath, {
      flags: startByte > 0 ? 'a' : 'w', // Append if resuming, write new if starting
      start: startByte
    });

    // Enhanced download with resume capability
    const response = await axios.get(video.fileUrl, {
      responseType: "stream",
      timeout: 300000, // 5 minute timeout
      headers: {
        'User-Agent': `ADS-Display/${RPI_ID}`,
        'Accept': 'video/mp4,video/*,application/octet-stream',
        'Referer': SERVER_URL,
        ...(startByte > 0 && { 'Range': `bytes=${startByte}-` }) // Resume from where we left off
      },
      maxRedirects: 5,
      validateStatus: function (status) {
        // Accept 200 (full download), 206 (partial content), and 416 (range not satisfiable)
        return status === 200 || status === 206 || status === 416;
      },
      onDownloadProgress: (progressEvent) => {
        const { loaded, total } = progressEvent;
        const downloadedBytes = startByte + loaded;
        const totalBytes = fileSize || total;

        if (totalBytes && totalBytes > 0) {
          const percentComplete = Math.round((downloadedBytes * 100) / totalBytes);
          const downloadedMB = (downloadedBytes / (1024 * 1024)).toFixed(2);
          const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
          
          process.stdout.write(
            clc.blue.bold(
              `Downloading ${filenameWithExt}: ${percentComplete}% (${downloadedMB}/${totalMB} MB)\r`
            )
          );
        } else {
          const downloadedMB = (downloadedBytes / (1024 * 1024)).toFixed(2);
          process.stdout.write(
            clc.blue.bold(
              `Downloading ${filenameWithExt}: ${downloadedMB} MB downloaded\r`
            )
          );
        }
      },
    });

    // Handle different status codes
    if (response.status === 416) {
      // Range not satisfiable - probably already downloaded completely
      if (fs.existsSync(tempPath)) {
        const stats = fs.statSync(tempPath);
        if (stats.size > 0) {
          logInfo(`File appears to be already downloaded: ${filenameWithExt}`);
          fs.renameSync(tempPath, localPath);
          return { success: true, filename: filenameWithExt, size: stats.size };
        }
      }
      throw new Error('Range not satisfiable - download may be corrupted');
    }

    if (response.status !== 200 && response.status !== 206) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Check if we're getting the expected range
    const contentRange = response.headers['content-range'];
    if (startByte > 0 && contentRange) {
      const rangeStart = parseInt(contentRange.split(' ')[1].split('-')[0]);
      if (rangeStart !== startByte) {
        logWarning(`Server returned different range than requested. Expected: ${startByte}, Got: ${rangeStart}`);
      }
    }

    // Pipe the response data to the local file
    response.data.pipe(writer);

    // Wait for the writing to finish
    return new Promise((resolve, reject) => {
      let isFinished = false;

      const finishDownload = () => {
        if (isFinished) return;
        isFinished = true;

        try {
          // Verify the file was actually written
          if (fs.existsSync(tempPath)) {
            const stats = fs.statSync(tempPath);
            if (stats.size > 0) {
              // Rename from temp to final name
              fs.renameSync(tempPath, localPath);
              
              const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
              console.log(
                clc.green.bold("\n✅ Download complete: ") + 
                clc.green(`${filenameWithExt} (${fileSizeMB} MB)`)
              );
              resolve({ 
                success: true, 
                filename: filenameWithExt, 
                size: stats.size,
                resumed: startByte > 0 
              });
            } else {
              fs.unlinkSync(tempPath);
              throw new Error('Downloaded file is empty');
            }
          } else {
            throw new Error('File was not created');
          }
        } catch (error) {
          reject(error);
        }
      };

      writer.on("finish", finishDownload);

      writer.on("error", (error) => {
        if (isFinished) return;
        isFinished = true;
        
        console.error(clc.red.bold("❌ Error writing file: "), error.message);
        
        // Don't delete temp file on error - we can resume later
        logInfo(`Download paused at ${fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0} bytes`);
        reject(error);
      });

      // Handle stream errors
      response.data.on('error', (error) => {
        if (isFinished) return;
        isFinished = true;
        
        console.error(clc.red.bold("❌ Stream error: "), error.message);
        logInfo(`Network error - download can be resumed`);
        reject(error);
      });

      // Handle request timeout or abort
      response.request.on('error', (error) => {
        if (isFinished) return;
        isFinished = true;
        
        console.error(clc.red.bold("❌ Request error: "), error.message);
        logInfo(`Request failed - download can be resumed`);
        reject(error);
      });
    });
  } catch (error) {
    console.log(
      clc.red.bold("❌ Failed to download ") + clc.red(filenameWithExt),
      error.message
    );
    
    // Check if we have a partial download that can be resumed
    const canResume = fs.existsSync(tempPath) && 
                     fs.statSync(tempPath).size > 0 && 
                     !error.message.includes('Range not satisfiable');

    if (canResume) {
      const currentSize = fs.statSync(tempPath).size;
      logInfo(`📥 Partial download saved (${currentSize} bytes) - can resume later`);
    }

    // More detailed error information
    if (error.response) {
      console.log(clc.red(`   Status: ${error.response.status}`));
      
      // Handle specific error cases
      if (error.response.status === 403) {
        console.log(clc.yellow("   🔒 S3 Access Denied"));
        
        // Clean up temp file on permission errors
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      }
    }

    // Retry logic with exponential backoff (only for network errors, not no-internet)
    if (attempt < maxRetries && 
        !error.message.includes('No internet connection') && 
        !error.message.includes('Range not satisfiable')) {
      const delay = Math.min(attempt * 10000, 60000); // 10, 20, 30, 40, 50 seconds max 1 minute
      console.log(clc.yellow(`   🔄 Retrying in ${delay/1000} seconds... (${attempt}/${maxRetries})`));
      await new Promise(resolve => setTimeout(resolve, delay));
      return await downloadVideo(video, attempt + 1);
    }
    
    // Final cleanup on permanent failure
    if (fs.existsSync(tempPath) && error.message.includes('No internet connection')) {
      // Keep partial file for resume when internet returns
      logInfo(`📥 Keeping partial file for resume when internet returns`);
    } else if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    
    return { 
      success: false, 
      filename: filenameWithExt, 
      error: error.message,
      attempt: attempt,
      canResume: canResume
    };
  }
};

export const downloadAllVideos = async (videos) => {
  // Check internet before starting any downloads
  if (!await isInternetConnected()) {
    logWarning('🌐 No internet connection - skipping all downloads');
    return { 
      successCount: 0, 
      failCount: videos.length, 
      failedVideos: videos.map(video => ({
        filename: video.filename,
        error: 'No internet connection',
        url: video.fileUrl,
        canResume: true
      })),
      resumeableCount: videos.length,
      permanentFailCount: 0,
      skipped: true
    };
  }

  logInfo(`🚀 Starting download of ${videos.length} videos...`);
  
  let successCount = 0;
  let failCount = 0;
  const failedVideos = [];
  
  // Check for any existing partial downloads
  const partialDownloads = await checkPartialDownloads();
  if (partialDownloads.length > 0) {
    logInfo(`📥 Found ${partialDownloads.length} partial downloads that can be resumed`);
  }
  
  logInfo(`📥 Attempting to download all ${videos.length} videos`);
  
  for (const video of videos) {
    try {
      // Check internet before each download
      if (!await isInternetConnected()) {
        throw new Error('Internet connection lost during sync');
      }

      logInfo(`--- Starting download: ${video.filename} ---`);
      const result = await downloadVideo(video);
      if (result.success) {
        successCount++;
        const status = result.resumed ? "🔄 Resumed and completed" : "✅ Successfully downloaded";
        const sizeMB = (result.size / (1024 * 1024)).toFixed(2);
        logSuccess(`${status}: ${video.filename} (${sizeMB} MB)`);
      } else {
        failCount++;
        failedVideos.push({
          filename: video.filename,
          error: result.error,
          url: video.fileUrl,
          attempt: result.attempt,
          canResume: result.canResume || false
        });
        
        if (result.canResume) {
          logWarning(`⏸️ Download paused: ${video.filename} - ${result.error}`);
        } else {
          logError(`❌ Failed to download: ${video.filename} - ${result.error}`);
        }
      }
    } catch (error) {
      failCount++;
      failedVideos.push({
        filename: video.filename,
        error: error.message,
        url: video.fileUrl,
        canResume: error.message.includes('internet') // Can resume if internet-related
      });
      logError(`💥 Error downloading ${video.filename}: ${error.message}`);
    }
  }
  
  // Final summary
  const resumeableCount = failedVideos.filter(f => f.canResume).length;
  const permanentFailCount = failedVideos.filter(f => !f.canResume).length;
  
  logSuccess(`🎉 Download summary: ${successCount} successful, ${resumeableCount} can resume, ${permanentFailCount} failed`);
  
  // Log failed videos for debugging
  if (failedVideos.length > 0) {
    if (resumeableCount > 0) {
      logWarning("Paused downloads (will resume when internet returns):");
      failedVideos.filter(f => f.canResume).forEach(failed => {
        logWarning(`   ⏸️ ${failed.filename}: ${failed.error}`);
      });
    }
    
    if (permanentFailCount > 0) {
      logError("Failed videos:");
      failedVideos.filter(f => !f.canResume).forEach(failed => {
        logError(`   ❌ ${failed.filename}: ${failed.error} (attempt ${failed.attempt || 1})`);
      });
    }
  }
  
  return { 
    successCount, 
    failCount, 
    failedVideos,
    resumeableCount,
    permanentFailCount
  };
};

// Check for partial downloads that can be resumed
export const checkPartialDownloads = async () => {
  try {
    if (!fs.existsSync(VIDEOS_DIR)) {
      return [];
    }
    
    const files = fs.readdirSync(VIDEOS_DIR);
    const partialFiles = files.filter(file => file.endsWith('.download'));
    
    const partialDownloads = partialFiles.map(file => {
      const finalName = file.replace('.download', '');
      const stats = fs.statSync(path.join(VIDEOS_DIR, file));
      return {
        filename: finalName,
        tempFile: file,
        downloadedBytes: stats.size,
        canResume: true
      };
    });
    
    return partialDownloads;
  } catch (error) {
    logError("Error checking partial downloads:", error);
    return [];
  }
};

// Clean up partial downloads
export const cleanupPartialDownloads = async () => {
  try {
    const partialDownloads = await checkPartialDownloads();
    for (const partial of partialDownloads) {
      const tempPath = path.join(VIDEOS_DIR, partial.tempFile);
      fs.unlinkSync(tempPath);
      logInfo(`🧹 Cleaned up partial download: ${partial.filename}`);
    }
    logSuccess(`🧹 Cleaned up ${partialDownloads.length} partial downloads`);
  } catch (error) {
    logError("Error cleaning up partial downloads:", error);
  }
};

export const fetchVideosList = async () => {
  // Check internet before fetching videos list
  if (!await isInternetConnected()) {
    logWarning('🌐 No internet connection - cannot fetch videos list');
    return [];
  }

  try {
    const response = await axios.get(`${SERVER_URL}/api/videos/active`, {
      timeout: 15000,
      headers: {
        'User-Agent': `ADS-Display/${RPI_ID}`,
        'Accept': 'application/json'
      }
    });
    
    if (!response.data || !response.data.videos) {
      throw new Error('Invalid response format from server');
    }
    
    const videos = response.data.videos;
    logInfo(`📥 Fetched ${videos.length} videos from server`);
    
    // Log all videos that will be attempted
    videos.forEach(video => {
      logInfo(`   🎬 ${video.filename}`);
    });
    
    return videos;
  } catch (error) {
    logError("Error fetching videos list:", error.message);
    
    // More detailed error information
    if (error.response) {
      logError(`Server responded with status: ${error.response.status}`);
      logError(`Response data: ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      logError('No response received from server');
    }
    
    return [];
  }
};

// New function to get local videos info (including partial downloads)
export const getLocalVideosInfo = () => {
  try {
    if (!fs.existsSync(VIDEOS_DIR)) {
      return [];
    }
    
    const files = fs.readdirSync(VIDEOS_DIR);
    const videoFiles = files.filter(file => file.endsWith('.mp4') && !file.endsWith('.download'));
    
    const videos = videoFiles.map(file => {
      const stats = fs.statSync(path.join(VIDEOS_DIR, file));
      return {
        filename: file,
        size: stats.size,
        modified: stats.mtime,
        status: 'complete'
      };
    });
    
    // Add partial downloads
    const partialFiles = files.filter(file => file.endsWith('.download'));
    partialFiles.forEach(file => {
      const finalName = file.replace('.download', '');
      const stats = fs.statSync(path.join(VIDEOS_DIR, file));
      videos.push({
        filename: finalName,
        size: stats.size,
        modified: stats.mtime,
        status: 'partial'
      });
    });
    
    const completeCount = videos.filter(v => v.status === 'complete').length;
    const partialCount = videos.filter(v => v.status === 'partial').length;
    
    logInfo(`📁 Found ${completeCount} complete videos, ${partialCount} partial downloads`);
    
    videos.forEach(video => {
      const status = video.status === 'complete' ? '✅' : '⏸️';
      const sizeMB = (video.size / (1024 * 1024)).toFixed(2);
      logInfo(`   ${status} ${video.filename} (${sizeMB} MB)`);
    });
    
    return videos;
  } catch (error) {
    logError("Error reading local videos:", error);
    return [];
  }
};

// New function to check server accessibility
export const checkServerAccessibility = async () => {
  if (!await isInternetConnected()) {
    logWarning('🌐 No internet connection - server not accessible');
    return false;
  }

  try {
    const response = await axios.get(`${SERVER_URL}/api/health`, {
      timeout: 10000,
      headers: {
        'User-Agent': `ADS-Display/${RPI_ID}`
      }
    });
    
    logSuccess(`🌐 Main server is reachable: ${response.status} ${response.statusText}`);
    return true;
  } catch (error) {
    logError(`🌐 Server accessibility check failed: ${error.message}`);
    return false;
  }
};

// New function to report download issues to server
export const reportDownloadIssue = async (filename, error, url) => {
  // Don't report issues if no internet
  if (!await isInternetConnected()) {
    logWarning('🌐 No internet connection - skipping issue reporting');
    return;
  }

  try {
    await axios.post(`${SERVER_URL}/api/videos/report-issue`, {
      deviceId: RPI_ID,
      filename: filename,
      error: error,
      url: url,
      timestamp: new Date().toISOString()
    }, {
      timeout: 10000,
      headers: {
        'User-Agent': `ADS-Display/${RPI_ID}`
      }
    });
    
    logInfo(`📤 Reported download issue for: ${filename}`);
  } catch (error) {
    logWarning(`📤 Could not report download issue: ${error.message}`);
  }
};