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
        return 0
    else
        # Alternative check using ps
        if pgrep Xorg > /dev/null 2>&1; then
            sleep 2
            if xset -q > /dev/null 2>&1; then
                return 0
            fi
        fi
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

        # Start X server
        if [ -f "/etc/X11/xorg.conf.headless" ]; then
            sudo X :0 -ac -nocursor -retro -config /etc/X11/xorg.conf.headless > /dev/null 2>&1 &
        else
            # Fallback: start X without special config
            sudo X :0 -ac -nocursor > /dev/null 2>&1 &
        fi
        
        local xserver_pid=$!
        echo "X server started with PID: $xserver_pid"

        # Wait for X server to be ready
        local max_attempts=20
        local attempt=1

        while [[ $attempt -le $max_attempts ]]; do
            if is_xserver_running; then
                echo "X server is ready (attempt $attempt)"

                # Set some basic X properties
                xset s off 2>/dev/null || true
                xset -dpms 2>/dev/null || true
                xset s noblank 2>/dev/null || true

                return 0
            fi

            # Check if process is still running
            if ! kill -0 $xserver_pid 2>/dev/null; then
                echo "Warning: X server process died, attempting alternative startup..."
                startx -- -nocursor > /dev/null 2>&1 &
                local new_pid=$!
                echo "Alternative X server started with PID: $new_pid"
                xserver_pid=$new_pid
            fi

            echo "Waiting for X server... (attempt $attempt/$max_attempts)"
            sleep 2
            ((attempt++))
        done

        echo "Warning: X server not ready after $max_attempts attempts"
        echo "Continuing without X server - video playback will be disabled"
        return 1
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

# OPTIMIZED MPV startup - NO LAG
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
    sleep 2
    
    # Kill any existing MPV processes
    pkill -f mpv || true
    sleep 1
    
    # Ensure playlist exists and is updated
    update_playlist
    
    # Check if there are videos to play
    if [[ ! -f "$PLAYLIST" ]] || [[ ! -s "$PLAYLIST" ]] || [[ $(wc -l < "$PLAYLIST" 2>/dev/null) -eq 0 ]]; then
        echo "No videos found in playlist. MPV will start but play nothing."
        echo "# Empty playlist - waiting for videos" > "$PLAYLIST"
    fi
    
    echo "Starting MPV with optimized configuration..."
    
    # CRITICAL: Use the working MPV configuration from your first script
    # This is what makes videos play smoothly
    mpv --fs \
        --shuffle \
        --loop-playlist=inf \
        --osd-level=0 \
        --no-terminal \
        --input-ipc-server="$MPV_SOCKET" \
        --playlist="$PLAYLIST" \
        --keep-open=yes \
        --no-resume-playback \
        --hwdec=auto \
        --vo=xv \
        --quiet > "$BASE_DIR/logs/mpv.log" 2>&1 &
    
    local mpv_pid=$!
    
    echo "MPV started with IPC socket: $MPV_SOCKET (PID: $mpv_pid)"
    
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
            echo "MPV process died, trying alternative configuration..."
            break
        fi

        sleep 1
        ((mpv_attempts++))
    done
    
    echo "MPV playback started successfully"
    return 0
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
    
    # Start X server if needed (for Lite version)
    if is_lite_version; then
        start_xserver
    fi
    
    # Wait a moment for system to stabilize
    sleep 3
    
    # Initial playlist creation
    echo "Setting up video playback..."
    update_playlist
    
    # Start MPV playback (only if X server is available)
    if is_xserver_running; then
        start_mpv
    else
        echo "X server not available - video playback disabled"
        echo "Check X server configuration and restart"
        return 1
    fi
    
    # Monitor directory for changes (run in background)
    monitor_directory &
    
    # Start periodic playlist refresh (run in background)
    start_periodic_playlist_refresh &
    
    echo "=========================================="
    echo "ADS Display System Started Successfully"
    echo "User: $USERNAME"
    echo "Base Directory: $BASE_DIR"
    echo "Time: $(date)"
    echo "Playlist monitoring: ACTIVE"
    echo "Periodic refresh: EVERY 5 MINUTES"
    echo "Video directory: $VIDEO_DIR"
    echo "=========================================="
    
    # Keep script running and monitor MPV process
    while true; do
        # Check if MPV is still running
        if ! pgrep -f mpv > /dev/null; then
            echo "Warning: MPV stopped. Restarting..."
            start_mpv
        fi
        
        # Reduce monitoring frequency to save CPU
        sleep 30
    done
}

# Error handling
handle_error() {
    echo "Error occurred in ADS Display startup script!"
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