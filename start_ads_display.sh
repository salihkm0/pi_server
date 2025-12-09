#!/bin/bash

# ADS Display Startup Script
# Optimized for Zebronics ZEB-V16HD LED Monitor (16:9 aspect ratio)
# Compatible with both Raspberry Pi Desktop and Lite versions

# Configuration - Dynamic paths based on Desktop availability
USERNAME=$(whoami)

if [ -d "/home/$USERNAME/Desktop" ]; then
    # Desktop version
    BASE_DIR="/home/$USERNAME/Desktop/pi_server"
else
    # Lite version
    BASE_DIR="/home/$USERNAME/pi_server"
fi

VIDEO_DIR="$BASE_DIR/ads-videos"
PLAYLIST="$VIDEO_DIR/playlist.txt"
MPV_SOCKET="/tmp/mpv-socket"
LOG_FILE="$BASE_DIR/logs/ads_display.log"
MPV_LOG="$BASE_DIR/logs/mpv_debug.log"

# Monitor Specifications (Zebronics ZEB-V16HD)
MONITOR_MODEL="ZEB-V16HD"
MONITOR_ASPECT_RATIO="16:9"  # Standard for HD monitors
MONITOR_RESOLUTION="1366x768"  # Most common for 16" HD monitors

# Ensure directories exist
mkdir -p "$BASE_DIR/logs"
mkdir -p "$VIDEO_DIR"

# Redirect all output to log file
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=========================================="
echo "ADS Display Startup Script"
echo "Optimized for: $MONITOR_MODEL ($MONITOR_ASPECT_RATIO, $MONITOR_RESOLUTION)"
echo "User: $USERNAME"
echo "Base Directory: $BASE_DIR"
echo "Started at: $(date)"
echo "=========================================="

# Set PATH for cron environment
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin

# Set DISPLAY for GUI applications like MPV
export DISPLAY=:0

# Set XAUTHORITY if it exists
if [ -f "/home/$USERNAME/.Xauthority" ]; then
    export XAUTHORITY="/home/$USERNAME/.Xauthority"
elif [ -f "/root/.Xauthority" ]; then
    export XAUTHORITY="/root/.Xauthority"
fi

# Function to check if we're on Raspberry Pi Lite
is_lite_version() {
    if [ -d "/home/$USERNAME/Desktop" ]; then
        return 1  # Desktop version
    else
        return 0  # Lite version
    fi
}

# Function to check if X server is running
is_xserver_running() {
    if xset -q > /dev/null 2>&1; then
        echo "X server is running (xset check passed)"
        return 0
    else
        # Alternative check using ps
        if pgrep Xorg > /dev/null 2>&1; then
            echo "Xorg process found, waiting for it to be ready..."
            sleep 2
            if xset -q > /dev/null 2>&1; then
                echo "X server is now ready"
                return 0
            fi
        fi
        echo "X server is NOT running"
        return 1
    fi
}

# Function to set optimal display settings for Zebronics monitor
set_display_settings() {
    echo "Configuring display for $MONITOR_MODEL..."
    
    if ! is_xserver_running; then
        echo "X server not available, cannot set display settings"
        return 1
    fi
    
    # Try to set optimal resolution and refresh rate
    echo "Attempting to set optimal display mode..."
    
    # Check current resolution
    CURRENT_RES=$(xrandr --current 2>/dev/null | grep '*' | awk '{print $1}' || echo "Unknown")
    echo "Current resolution: $CURRENT_RES"
    
    # List available modes
    echo "Available display modes:"
    xrandr 2>/dev/null | grep -E "[0-9]+x[0-9]+" || true
    
    # Try to set to optimal resolution (if supported)
    case "$MONITOR_RESOLUTION" in
        "1366x768")
            echo "Setting 1366x768 resolution if available..."
            xrandr --output HDMI-1 --mode 1366x768 2>/dev/null || \
            xrandr --output HDMI-2 --mode 1366x768 2>/dev/null || \
            xrandr --output HDMI-0 --mode 1366x768 2>/dev/null || \
            xrandr --output HDMI-1 --mode 1280x720 2>/dev/null || \
            echo "Could not set specific resolution, using default"
            ;;
        "1280x720")
            echo "Setting 1280x720 resolution if available..."
            xrandr --output HDMI-1 --mode 1280x720 2>/dev/null || \
            xrandr --output HDMI-2 --mode 1280x720 2>/dev/null || \
            xrandr --output HDMI-0 --mode 1280x720 2>/dev/null || \
            echo "Could not set specific resolution, using default"
            ;;
    esac
    
    # Set X properties for optimal video playback
    echo "Setting X server properties..."
    xset s off 2>/dev/null || true
    xset -dpms 2>/dev/null || true
    xset s noblank 2>/dev/null || true
    
    # Disable screen saver
    xset s 0 0 2>/dev/null || true
    
    echo "Display configuration complete"
    return 0
}

# Function to start X server for Lite version
start_xserver() {
    if is_lite_version; then
        echo "Lite version detected - checking X server..."

        # Check if X server is already running
        if is_xserver_running; then
            echo "X server is already running"
            return 0
        fi

        # Kill any existing X servers that might be stuck
        pkill Xorg 2>/dev/null || true
        sleep 2

        echo "Starting X server for $MONITOR_MODEL..."

        # Try to start X with optimal settings for this monitor
        local xserver_started=false
        
        # Try 1: Start with specific resolution for Zebronics monitor
        echo "Attempt 1: Starting X with optimal settings..."
        startx -- -nocursor -s 0 -dpms > "$BASE_DIR/logs/xserver.log" 2>&1 &
        local xserver_pid=$!
        sleep 3
        
        if is_xserver_running; then
            echo "X server started successfully"
            xserver_started=true
        else
            echo "Standard config failed, trying alternative..."
            pkill Xorg 2>/dev/null || true
            sleep 2
            
            # Try 2: Start with framebuffer
            echo "Attempt 2: Starting X with framebuffer..."
            sudo X :0 -nocursor -s 0 -dpms -br > "$BASE_DIR/logs/xserver.log" 2>&1 &
            xserver_pid=$!
            sleep 3
            
            if is_xserver_running; then
                echo "X server started successfully with framebuffer"
                xserver_started=true
            fi
        fi
        
        if [ "$xserver_started" = true ]; then
            # Wait a bit more for X to stabilize
            sleep 2
            
            # Set display settings for Zebronics monitor
            set_display_settings
            
            echo "X server ready for $MONITOR_MODEL"
            return 0
        else
            echo "Warning: X server failed to start"
            echo "Check /var/log/Xorg.0.log for details"
            return 1
        fi
    fi
    return 0
}

# Function to update the playlist
update_playlist() {
    echo "Updating playlist..."
    
    # Create playlist file if it doesn't exist
    touch "$PLAYLIST"
    
    if [[ -d "$VIDEO_DIR" ]]; then
        # Find all video files and create playlist
        find "$VIDEO_DIR" -type f \( -name "*.mp4" -o -name "*.avi" -o -name "*.mkv" -o -name "*.mov" -o -name "*.webm" \) > "$PLAYLIST.tmp"

        # Remove empty lines and sort
        grep -v '^$' "$PLAYLIST.tmp" | sort > "$PLAYLIST"
        rm -f "$PLAYLIST.tmp"

        local video_count=$(wc -l < "$PLAYLIST" 2>/dev/null || echo 0)
        echo "Playlist updated: $video_count videos found."

        if [[ $video_count -gt 0 ]]; then
            echo "Videos in playlist:"
            cat "$PLAYLIST"
        else
            echo "Warning: No video files found in $VIDEO_DIR"
            echo "Supported formats: mp4, avi, mkv, mov, webm"
            echo "# Empty playlist - waiting for videos" > "$PLAYLIST"
        fi
    else
        echo "Video directory not found: $VIDEO_DIR"
        mkdir -p "$VIDEO_DIR"
        echo "Created video directory: $VIDEO_DIR"
        echo "# Empty playlist - waiting for videos" > "$PLAYLIST"
    fi
    
    chmod 644 "$PLAYLIST"
    echo "Playlist file created/updated: $PLAYLIST"
}

# Function to force reload playlist in MPV
force_reload_playlist() {
    echo "Force reloading playlist in MPV..."
    update_playlist
    
    if [[ -S "$MPV_SOCKET" ]] && command -v socat > /dev/null 2>&1; then
        echo "Sending playlist reload command to MPV..."
        local escaped_playlist=$(echo "$PLAYLIST" | sed 's/"/\\"/g')
        echo '{ "command": ["loadlist", "'"$escaped_playlist"'", "replace"] }' | socat - "$MPV_SOCKET" 2>/dev/null
        if [ $? -eq 0 ]; then
            echo "Playlist reload command sent successfully to MPV"
        else
            echo "Failed to send reload command to MPV"
        fi
    else
        echo "MPV socket not available or socat not installed"
        echo "Restarting MPV to load new playlist..."
        start_mpv
    fi
}

# Function to optimize video playback for Zebronics monitor
optimize_video_playback() {
    echo "Optimizing video playback for $MONITOR_MODEL ($MONITOR_ASPECT_RATIO)..."
    
    # Get first video for testing
    local first_video=$(head -1 "$PLAYLIST" 2>/dev/null | grep -v "^#")
    
    if [ -z "$first_video" ] || [ ! -f "$first_video" ]; then
        echo "No video file found for optimization test"
        return "auto"
    fi
    
    # Test different configurations to find the best one
    local best_backend="auto"
    local backends=("gpu" "x11" "drm" "libmpv")
    
    for backend in "${backends[@]}"; do
        echo "Testing backend: $backend"
        timeout 3 mpv --fs --vo=$backend --no-audio "$first_video" > /dev/null 2>&1
        local exit_code=$?
        
        if [ $exit_code -eq 0 ] || [ $exit_code -eq 124 ]; then  # 0=success, 124=timeout
            echo "✓ Backend $backend works well"
            best_backend=$backend
            break
        fi
    done
    
    echo "Selected video backend: $best_backend"
    echo "Aspect ratio setting: $MONITOR_ASPECT_RATIO"
    
    echo "$best_backend"
}

# MPV startup optimized for Zebronics ZEB-V16HD monitor
start_mpv() {
    echo "Starting MPV playback for $MONITOR_MODEL..."
    
    # Check if MPV is installed
    if ! command -v mpv &> /dev/null; then
        echo "Error: MPV is not installed. Video playback disabled."
        echo "Install MPV with: sudo apt install mpv"
        return 1
    fi
    
    # Check if X server is available
    if ! is_xserver_running; then
        echo "Warning: X server not available. Attempting to start..."
        if ! start_xserver; then
            echo "Error: X server not available. Cannot start MPV."
            return 1
        fi
    fi
    
    # Set display settings for optimal viewing
    set_display_settings
    
    # Additional wait for X server stability
    echo "Waiting for display to stabilize..."
    sleep 3
    
    # Kill any existing MPV processes
    pkill -f mpv || true
    sleep 2
    
    # Ensure playlist exists and is updated
    update_playlist
    
    # Check if there are videos to play
    if [[ ! -f "$PLAYLIST" ]] || [[ ! -s "$PLAYLIST" ]] || [[ $(wc -l < "$PLAYLIST" 2>/dev/null) -eq 0 ]]; then
        echo "No videos found in playlist. Creating a test pattern..."
        # Create a simple test video if none exists
        create_test_video
        update_playlist
    fi
    
    # Optimize video playback settings for this monitor
    local optimal_backend=$(optimize_video_playback)
    
    echo "Starting MPV with $optimal_backend backend for $MONITOR_ASPECT_RATIO display..."
    
    # Create MPV config directory if it doesn't exist
    mkdir -p ~/.config/mpv
    
    # Start MPV with settings optimized for Zebronics 16:9 monitor
    mpv --fs \
        --loop-playlist=inf \
        --no-terminal \
        --input-ipc-server="$MPV_SOCKET" \
        --playlist="$PLAYLIST" \
        --vo="$optimal_backend" \
        --hwdec=auto \
        --video-aspect="$MONITOR_ASPECT_RATIO" \
        --video-aspect-method=contain \
        --video-unscaled=no \
        --video-zoom=0 \
        --video-pan-x=0 \
        --video-pan-y=0 \
        --no-border \
        --ontop \
        --no-osc \
        --no-osd-bar \
        --osd-level=0 \
        --volume=100 \
        --no-input-default-bindings \
        --input-conf=/dev/null \
        --log-file="$MPV_LOG" \
        --msg-level=all=info \
        --demuxer-max-bytes=500M \
        --demuxer-max-back-bytes=250M \
        --cache=yes \
        --cache-secs=10 \
        > /dev/null 2>&1 &
    
    local mpv_pid=$!
    
    echo "MPV started with PID: $mpv_pid"
    echo "Monitor: $MONITOR_MODEL"
    echo "Aspect ratio: $MONITOR_ASPECT_RATIO"
    echo "Backend: $optimal_backend"
    echo "Debug log: $MPV_LOG"
    
    # Wait for MPV to initialize
    local mpv_attempts=0
    local mpv_max_attempts=10
    while [[ $mpv_attempts -lt $mpv_max_attempts ]]; do
        if [[ -S "$MPV_SOCKET" ]]; then
            echo "MPV IPC socket is ready (attempt $((mpv_attempts + 1)))"
            break
        fi

        # Check if MPV process is still alive
        if ! kill -0 $mpv_pid 2>/dev/null; then
            echo "MPV process died, checking logs..."
            if [ -f "$MPV_LOG" ]; then
                echo "Last 10 lines of MPV log:"
                tail -10 "$MPV_LOG"
            fi
            echo "Trying fallback configuration..."
            start_mpv_fallback
            return
        fi

        echo "Waiting for MPV to initialize... ($((mpv_attempts + 1))/$mpv_max_attempts)"
        sleep 1
        ((mpv_attempts++))
    done
    
    if [[ $mpv_attempts -eq $mpv_max_attempts ]]; then
        echo "Warning: MPV took too long to initialize"
    else
        echo "MPV playback started successfully"
        echo "Displaying on $MONITOR_MODEL ($MONITOR_ASPECT_RATIO)"
    fi
    
    return 0
}

# Fallback MPV startup (simpler)
start_mpv_fallback() {
    echo "Starting MPV with fallback configuration..."
    
    pkill -f mpv || true
    sleep 1
    
    # Simple MPV command - most likely to work
    mpv --fs \
        --loop-playlist=inf \
        --playlist="$PLAYLIST" \
        --video-aspect="$MONITOR_ASPECT_RATIO" \
        --no-audio \
        --no-terminal \
        --quiet &
    
    local mpv_pid=$!
    sleep 3
    
    if kill -0 $mpv_pid 2>/dev/null; then
        echo "MPV fallback started with PID: $mpv_pid"
        return 0
    else
        echo "Fallback MPV also failed"
        return 1
    fi
}

# Create a test video optimized for 16:9 aspect ratio
create_test_video() {
    local test_video="$VIDEO_DIR/test_pattern_16x9.mp4"
    
    if [ -f "$test_video" ]; then
        return 0
    fi
    
    echo "Creating 16:9 test pattern video for $MONITOR_MODEL..."
    
    # Check if ffmpeg is available
    if command -v ffmpeg &> /dev/null; then
        # Create a simple 10-second 16:9 test pattern
        # Using 1280x720 resolution (perfect 16:9)
        ffmpeg -f lavfi -i testsrc=duration=10:size=1280x720:rate=30 \
               -f lavfi -i sine=frequency=1000:duration=10 \
               -c:v libx264 -preset ultrafast -crf 23 \
               -c:a aac -b:a 128k \
               -vf "drawtext=text='Zebronics $MONITOR_MODEL Test':fontsize=30:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" \
               "$test_video" > "$BASE_DIR/logs/ffmpeg.log" 2>&1
               
        if [ $? -eq 0 ] && [ -f "$test_video" ]; then
            echo "16:9 test video created: $test_video"
            return 0
        fi
    fi
    
    # Alternative: Try to create a simpler test video
    echo "Creating simple color test pattern..."
    if command -v ffmpeg &> /dev/null; then
        ffmpeg -f lavfi -i color=c=blue:s=1280x720:d=10 \
               -vf "drawtext=text='$MONITOR_MODEL':fontsize=50:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" \
               -c:v libx264 -preset ultrafast "$test_video" 2>/dev/null
    fi
    
    if [ -f "$test_video" ]; then
        echo "Test video created: $test_video"
        return 0
    fi
    
    return 1
}

# Directory monitoring for automatic playlist updates
monitor_directory() {
    echo "Monitoring $VIDEO_DIR for changes..."
    
    # Check if inotifywait is available
    if ! command -v inotifywait &> /dev/null; then
        echo "Warning: inotifywait not available. Directory monitoring disabled."
        echo "Install inotify-tools for automatic directory monitoring."

        # Fallback: periodic polling
        echo "Using periodic polling as fallback (every 60 seconds)..."
        while true; do
            sleep 60
            echo "Periodic playlist check..."
            update_playlist
            # Only reload if MPV is running
            if pgrep mpv > /dev/null; then
                force_reload_playlist
            fi
        done &
        return 0
    fi
    
    # Create monitoring loop
    while true; do
        echo "Starting directory monitor..."

        inotifywait -r -e create -e modify -e moved_to -e close_write --format '%w%f' "$VIDEO_DIR" 2>/dev/null | while read -r file; do
            echo "File change detected: $file"

            # Check if it's a video file
            if [[ "$file" =~ \.(mp4|avi|mkv|mov|webm)$ ]]; then
                echo "Video file detected: $file"

                # Wait for file to be completely written
                sleep 5

                # Check if file is readable and has content
                if [[ -f "$file" ]] && [[ -r "$file" ]] && [[ -s "$file" ]]; then
                    echo "File is ready: $file"

                    # Update playlist
                    update_playlist

                    # Reload MPV playlist
                    force_reload_playlist

                    echo "Playlist updated with new video: $(basename "$file")"
                else
                    echo "File not ready or empty: $file"
                fi
            fi
        done

        # If inotifywait fails, wait and restart
        echo "Directory monitor stopped, restarting in 10 seconds..."
        sleep 10
    done &
}

# Additional function: Monitor health check
monitor_health_check() {
    echo "Starting monitor health check (every 60 seconds)..."
    while true; do
        sleep 60
        
        # Check if X server is still running
        if ! is_xserver_running; then
            echo "X server has stopped! Attempting to restart..."
            start_xserver
            sleep 5
            if is_xserver_running; then
                echo "Restarting MPV..."
                start_mpv
            fi
        fi
        
        # Check actual resolution
        CURRENT_RES=$(xrandr --current 2>/dev/null | grep '*' | awk '{print $1}' || echo "Unknown")
        echo "Monitor check: $MONITOR_MODEL, Resolution: $CURRENT_RES, MPV running: $(pgrep mpv > /dev/null && echo "Yes" || echo "No")"
    done &
}

# Main startup sequence
main() {
    echo "Starting ADS Display System for $MONITOR_MODEL..."
    
    # Display system and monitor info
    echo "=========================================="
    echo "Monitor Specifications:"
    echo "Model: $MONITOR_MODEL"
    echo "Aspect Ratio: $MONITOR_ASPECT_RATIO"
    echo "Optimal Resolution: $MONITOR_RESOLUTION"
    echo "=========================================="
    echo "System information:"
    uname -a
    echo "MPV version:" $(mpv --version 2>/dev/null | head -1 || echo "Not installed")
    echo "FFmpeg version:" $(ffmpeg -version 2>/dev/null | head -1 || echo "Not installed")
    
    # Start X server if needed (for Lite version)
    if is_lite_version; then
        start_xserver
    else
        echo "Desktop version detected, using existing X server"
        set_display_settings
    fi
    
    # Check X server
    if ! is_xserver_running; then
        echo "ERROR: X server is not running!"
        echo "Attempting to start X server..."
        start_xserver
    fi
    
    # Wait for system to stabilize
    echo "Waiting for system to stabilize..."
    sleep 5
    
    # Initial playlist creation
    echo "Setting up video playback for $MONITOR_ASPECT_RATIO display..."
    update_playlist
    
    # Start MPV playback
    echo "Starting video player optimized for $MONITOR_MODEL..."
    start_mpv
    
    # Monitor directory for changes (run in background)
    monitor_directory &
    
    # Monitor health check (run in background)
    monitor_health_check &
    
    echo "=========================================="
    echo "ADS Display System Started Successfully"
    echo "Monitor: $MONITOR_MODEL ($MONITOR_ASPECT_RATIO)"
    echo "User: $USERNAME"
    echo "Time: $(date)"
    echo "Video directory: $VIDEO_DIR"
    echo "Log file: $LOG_FILE"
    echo "=========================================="
    echo "Troubleshooting tips for $MONITOR_MODEL:"
    echo "1. Check if correct resolution is set: xrandr"
    echo "2. Test video manually: mpv --fs --video-aspect=16:9 /path/to/video.mp4"
    echo "3. Check HDMI connection to monitor"
    echo "4. Monitor should display 16:9 widescreen videos correctly"
    echo "=========================================="
    
    # Keep script running and monitor MPV process
    while true; do
        # Check if MPV is still running
        if ! pgrep -f mpv > /dev/null; then
            echo "Warning: MPV stopped. Restarting in 5 seconds..."
            sleep 5
            start_mpv
        fi
        
        # Reduce monitoring frequency to save CPU
        sleep 30
    done
}

# Error handling
handle_error() {
    echo "Error occurred in ADS Display startup script!"
    echo "Error: $1"
    echo "Check the log file for more details: $LOG_FILE"
    
    # Try to restart main function after a delay
    sleep 10
    echo "Attempting to restart..."
    main
}

# Set error trap
trap 'handle_error "Script terminated unexpectedly"' ERR

# Run main function
main