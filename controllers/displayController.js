import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec);

/**
 * Get display details using xrandr.
 * @returns {Promise<object[]>} - A promise resolving to an array of display details.
 */
export const getDisplayDetails = async () => {
  try {
    const { stdout, stderr } = await execAsync("xrandr --query");
    
    if (stderr) {
      throw new Error(`xrandr error: ${stderr}`);
    }

    const displays = [];
    const lines = stdout.split("\n");
    
    lines.forEach((line) => {
      if (line.includes(" connected")) {
        const parts = line.split(/\s+/);
        const name = parts[0];
        const status = "connected";
        
        // Extract resolution (look for pattern like 1920x1080)
        const resolutionMatch = line.match(/(\d+x\d+)/);
        const resolution = resolutionMatch ? resolutionMatch[0] : "Unknown";
        
        // Extract primary display
        const isPrimary = line.includes("primary");
        
        displays.push({
          name,
          status,
          resolution,
          isPrimary,
          type: this.detectDisplayType(name)
        });
      } else if (line.includes(" disconnected")) {
        const parts = line.split(/\s+/);
        const name = parts[0];
        
        displays.push({
          name,
          status: "disconnected",
          resolution: "N/A",
          isPrimary: false,
          type: this.detectDisplayType(name)
        });
      }
    });

    return displays;
  } catch (error) {
    console.error("Error getting display details:", error);
    
    // Fallback for systems without xrandr (like macOS)
    if (process.platform === 'darwin') {
      return await this.getMacDisplayDetails();
    }
    
    throw error;
  }
};

// Detect display type based on name
getDisplayDetails.detectDisplayType = (name) => {
  if (name.includes('HDMI') || name.includes('hdmi')) return 'HDMI';
  if (name.includes('DP') || name.includes('dp')) return 'DisplayPort';
  if (name.includes('VGA') || name.includes('vga')) return 'VGA';
  if (name.includes('LVDS') || name.includes('lvds')) return 'LVDS';
  if (name.includes('eDP') || name.includes('edp')) return 'eDP';
  return 'Unknown';
};

// macOS specific display detection
getDisplayDetails.getMacDisplayDetails = async () => {
  try {
    const { stdout } = await execAsync("system_profiler SPDisplaysDataType | grep -E '(Resolution|UI Looks like)'");
    const lines = stdout.split('\n');
    
    const displays = [];
    let currentDisplay = {};
    
    lines.forEach(line => {
      if (line.includes('UI Looks like')) {
        if (currentDisplay.name) {
          displays.push(currentDisplay);
        }
        currentDisplay = {
          name: line.split('UI Looks like')[1].trim(),
          status: 'connected',
          isPrimary: displays.length === 0
        };
      } else if (line.includes('Resolution')) {
        const resolutionMatch = line.match(/\d+\s*x\s*\d+/);
        if (resolutionMatch) {
          currentDisplay.resolution = resolutionMatch[0].replace(/\s+/g, '');
        }
      }
    });
    
    if (currentDisplay.name) {
      displays.push(currentDisplay);
    }
    
    return displays;
  } catch (error) {
    console.error("Error getting macOS display details:", error);
    return [{
      name: 'Unknown Display',
      status: 'connected',
      resolution: 'Unknown',
      isPrimary: true,
      type: 'Unknown'
    }];
  }
};

// Set display resolution
export const setDisplayResolution = async (displayName, resolution) => {
  try {
    const { stdout, stderr } = await execAsync(`xrandr --output ${displayName} --mode ${resolution}`);
    
    if (stderr) {
      throw new Error(`xrandr error: ${stderr}`);
    }
    
    return {
      success: true,
      message: `Resolution set to ${resolution} for ${displayName}`
    };
  } catch (error) {
    console.error("Error setting display resolution:", error);
    throw error;
  }
};

// Rotate display
export const rotateDisplay = async (displayName, direction = 'normal') => {
  try {
    const validDirections = ['normal', 'left', 'right', 'inverted'];
    if (!validDirections.includes(direction)) {
      throw new Error(`Invalid rotation direction: ${direction}`);
    }
    
    const { stdout, stderr } = await execAsync(`xrandr --output ${displayName} --rotation ${direction}`);
    
    if (stderr) {
      throw new Error(`xrandr error: ${stderr}`);
    }
    
    return {
      success: true,
      message: `Display ${displayName} rotated to ${direction}`
    };
  } catch (error) {
    console.error("Error rotating display:", error);
    throw error;
  }
};