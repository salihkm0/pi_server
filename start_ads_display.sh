#!/bin/bash

# ADS Display Startup Script
# Video playback without WiFi and black screen options
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

# Ensure directories exist
mkdir -p "$BASE_DIR/logs"
mkdir -p "$VIDEO_DIR"

# Redirect all output to log file
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=========================================="
echo "ADS Display Startup Script"
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

        echo "Starting X server..."

        # Try different X server configurations
        local xserver_started=false
        
        # Try 1: Start with standard config
        echo "Attempt 1: Starting X with standard configuration..."
        startx -- -nocursor -s 0 -dpms > "$BASE_DIR/logs/xserver.log" 2>&1 &
        local xserver_pid=$!
        sleep 3
        
        if is_xserver_running; then
            echo "X server started successfully with standard config"
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
            
            # Set X properties
            xset s off 2>/dev/null || true
            xset -dpms 2>/dev/null || true
            xset s noblank 2>/dev/null || true
            
            echo "X server properties set"
            return 0
        else
            echo "Warning: X server failed to start with both configurations"
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

# Function to test video playback with different configurations
test_video_playback() {
    local test_video="$1"
    
    if [ ! -f "$test_video" ]; then
        echo "Test video not found: $test_video"
        return 1
    fi
    
    echo "Testing video playback with: $test_video"
    
    # Test 1: Basic mpv with x11
    echo "Test 1: mpv with x11 backend..."
    timeout 10 mpv --fs --vo=x11 "$test_video" > "$BASE_DIR/logs/test_x11.log" 2>&1
    if [ $? -eq 0 ]; then
        echo "✓ x11 backend works"
        return 0
    fi
    
    # Test 2: mpv with gpu
    echo "Test 2: mpv with gpu backend..."
    timeout 10 mpv --fs --vo=gpu "$test_video" > "$BASE_DIR/logs/test_gpu.log" 2>&1
    if [ $? -eq 0 ]; then
        echo "✓ gpu backend works"
        return 0
    fi
    
    # Test 3: mpv with drm (for Raspberry Pi)
    echo "Test 3: mpv with drm backend..."
    timeout 10 mpv --fs --vo=drm "$test_video" > "$BASE_DIR/logs/test_drm.log" 2>&1
    if [ $? -eq 0 ]; then
        echo "✓ drm backend works"
        return 0
    fi
    
    # Test 4: mpv with libmpv
    echo "Test 4: mpv with libmpv backend..."
    timeout 10 mpv --fs --vo=libmpv "$test_video" > "$BASE_DIR/logs/test_libmpv.log" 2>&1
    if [ $? -eq 0 ]; then
        echo "✓ libmpv backend works"
        return 0
    fi
    
    echo "✗ All video output tests failed"
    return 1
}

# OPTIMIZED MPV startup - FIXED for black screen
start_mpv() {
    echo "Starting MPV playback..."
    
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
    
    # Additional wait for X server stability
    echo "Waiting for X server to stabilize..."
    sleep 5
    
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
    
    # Get first video for testing
    local first_video=$(head -1 "$PLAYLIST" 2>/dev/null | grep -v "^#")
    
    # Test different configurations
    echo "Testing video playback configuration..."
    
    # Try to find a working video output backend
    local working_backend=""
    local backends=("x11" "gpu" "drm" "libmpv" "null")
    
    for backend in "${backends[@]}"; do
        echo "Testing backend: $backend"
        timeout 5 mpv --fs --vo=$backend --no-audio "$first_video" > /dev/null 2>&1
        if [ $? -eq 0 ] || [ $? -eq 124 ]; then  # 124 is timeout
            echo "✓ Backend $backend seems to work"
            working_backend=$backend
            break
        fi
    done
    
    if [ -z "$working_backend" ]; then
        echo "Warning: No video backend found, using x11 as fallback"
        working_backend="x11"
    fi
    
    echo "Starting MPV with $working_backend backend..."
    
    # Create MPV config directory if it doesn't exist
    mkdir -p ~/.config/mpv
    
    # Start MPV with the working backend - SIMPLIFIED configuration
    mpv --fs \
        --loop-playlist=inf \
        --no-terminal \
        --input-ipc-server="$MPV_SOCKET" \
        --playlist="$PLAYLIST" \
        --vo="$working_backend" \
        --hwdec=auto \
        --profile=high-quality \
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
        "$first_video" > /dev/null 2>&1 &
    
    local mpv_pid=$!
    
    echo "MPV started with PID: $mpv_pid (using $working_backend backend)"
    echo "MPV debug log: $MPV_LOG"
    
    # Wait for MPV to initialize
    local mpv_attempts=0
    local mpv_max_attempts=15
    while [[ $mpv_attempts -lt $mpv_max_attempts ]]; do
        if [[ -S "$MPV_SOCKET" ]]; then
            echo "MPV IPC socket is ready (attempt $((mpv_attempts + 1)))"
            break
        fi

        # Check if MPV process is still alive
        if ! kill -0 $mpv_pid 2>/dev/null; then
            echo "MPV process died, checking logs..."
            if [ -f "$MPV_LOG" ]; then
                tail -20 "$MPV_LOG"
            fi
            echo "Trying alternative configuration..."
            start_mpv_fallback
            return
        fi

        echo "Waiting for MPV to initialize... ($((mpv_attempts + 1))/$mpv_max_attempts)"
        sleep 1
        ((mpv_attempts++))
    done
    
    if [[ $mpv_attempts -eq $mpv_max_attempts ]]; then
        echo "Warning: MPV took too long to initialize"
        echo "Checking if it's running anyway..."
        if pgrep mpv > /dev/null; then
            echo "MPV is running but socket not created"
        fi
    fi
    
    echo "MPV playback started"
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

# Create a test video if no videos exist
create_test_video() {
    local test_video="$VIDEO_DIR/test_pattern.mp4"
    
    if [ -f "$test_video" ]; then
        return 0
    fi
    
    echo "Creating test pattern video..."
    
    # Check if ffmpeg is available
    if command -v ffmpeg &> /dev/null; then
        # Create a simple 10-second test pattern
        ffmpeg -f lavfi -i testsrc=duration=10:size=1280x720:rate=30 \
               -f lavfi -i sine=frequency=1000:duration=10 \
               -c:v libx264 -preset ultrafast -crf 23 \
               -c:a aac -b:a 128k \
               "$test_video" > "$BASE_DIR/logs/ffmpeg.log" 2>&1
               
        if [ $? -eq 0 ] && [ -f "$test_video" ]; then
            echo "Test video created: $test_video"
            return 0
        fi
    fi
    
    # Alternative: Download a sample video
    echo "Attempting to download sample video..."
    wget -q -O "$test_video" "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4" || \
    wget -q -O "$test_video" "https://sample-videos.com/video123/mp4/720/big_buck_bunny_720p_1mb.mp4" || \
    echo "Could not create or download test video"
    
    if [ -f "$test_video" ]; then
        echo "Sample video downloaded: $test_video"
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

# Additional function: Periodic playlist refresh (safety net)
start_periodic_playlist_refresh() {
    echo "Starting periodic playlist refresh (every 5 minutes)..."
    while true; do
        sleep 300  # 5 minutes

        # Check if videos directory exists and has files
        if [[ -d "$VIDEO_DIR" ]]; then
            local current_count=$(find "$VIDEO_DIR" -type f \( -name "*.mp4" -o -name "*.avi" -o -name "*.mkv" -o -name "*.mov" -o -name "*.webm" \) | wc -l)
            local playlist_count=$(wc -l < "$PLAYLIST" 2>/dev/null || echo 0)

            if [[ $current_count -ne $playlist_count ]]; then
                echo "Playlist count mismatch (files: $current_count, playlist: $playlist_count). Updating..."
                update_playlist
                force_reload_playlist
            fi
        fi
    done &
}

# Main startup sequence
main() {
    echo "Starting ADS Display System..."
    
    # Display system info
    echo "System information:"
    uname -a
    echo "MPV version:" $(mpv --version 2>/dev/null | head -1 || echo "Not installed")
    echo "FFmpeg version:" $(ffmpeg -version 2>/dev/null | head -1 || echo "Not installed")
    
    # Start X server if needed (for Lite version)
    if is_lite_version; then
        start_xserver
    else
        echo "Desktop version detected, using existing X server"
    fi
    
    # Check X server
    if ! is_xserver_running; then
        echo "ERROR: X server is not running!"
        echo "Attempting to start X server..."
        start_xserver
    fi
    
    # Wait a moment for system to stabilize
    echo "Waiting for system to stabilize..."
    sleep 5
    
    # Initial playlist creation
    echo "Setting up video playback..."
    update_playlist
    
    # Start MPV playback
    echo "Starting video player..."
    start_mpv
    
    # Monitor directory for changes (run in background)
    monitor_directory &
    
    # Start periodic playlist refresh (run in background)
    start_periodic_playlist_refresh &
    
    echo "=========================================="
    echo "ADS Display System Started"
    echo "User: $USERNAME"
    echo "Base Directory: $BASE_DIR"
    echo "Time: $(date)"
    echo "Playlist monitoring: ACTIVE"
    echo "Video directory: $VIDEO_DIR"
    echo "Log file: $LOG_FILE"
    echo "MPV log: $MPV_LOG"
    echo "=========================================="
    echo "If you see a black screen, check these:"
    echo "1. Check $MPV_LOG for errors"
    echo "2. Ensure videos exist in $VIDEO_DIR"
    echo "3. Run: xset q (to check X server)"
    echo "4. Run: mpv --fs /path/to/video.mp4 (to test manually)"
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