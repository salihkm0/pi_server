#!/bin/bash

# ADS Display Startup Script - Clean Version
# Video playback only - WiFi is managed by Node.js app
# Compatible with both Raspberry Pi Desktop and Lite versions

# Configuration - Dynamic paths based on Desktop availability
if [ -d "/home/$USER/Desktop" ]; then
    # Desktop version
    BASE_DIR="/home/$USER/Desktop/pi_server"
else
    # Lite version
    BASE_DIR="/home/$USER/pi_server"
fi

VIDEO_DIR="$BASE_DIR/ads-videos"
PLAYLIST="$VIDEO_DIR/playlist.txt"
MPV_SOCKET="/tmp/mpv-socket"
LOG_FILE="$BASE_DIR/logs/ads_display.log"

# Get current username
USERNAME=$(whoami)

# Ensure directories exist
mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$VIDEO_DIR"

# Redirect all output to log file
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=========================================="
echo "ADS Display Startup Script (Clean)"
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
    if [ -d "/home/$USER/Desktop" ]; then
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
        if [ -f /usr/bin/startx ]; then
            startx -- -nocursor -retro > /dev/null 2>&1 &
        else
            sudo X :0 -ac -nocursor -retro > /dev/null 2>&1 &
        fi
        
        local xserver_pid=$!
        
        echo "X server started with PID: $xserver_pid"
        
        # Wait for X server to be ready
        local max_attempts=30
        local attempt=1
        
        while [[ $attempt -le $max_attempts ]]; do
            if is_xserver_running; then
                echo "X server is ready (attempt $attempt)"
                
                # Set some basic X properties
                xset s off 2>/dev/null || true
                xset -dpms 2>/dev/null || true
                xset s noblank 2>/dev/null || true
                xsetroot -solid black 2>/dev/null || true
                
                return 0
            fi
            
            echo "Waiting for X server... (attempt $attempt/$max_attempts)"
            sleep 3
            ((attempt++))
        done
        
        echo "Warning: X server not ready after $max_attempts attempts"
        return 1
    fi
    return 0
}

# Function to kill existing Node.js processes
kill_existing_node_processes() {
    echo "Checking for existing Node.js processes..."
    
    # Kill by port
    fuser -k 3006/tcp 2>/dev/null || true
    
    # Kill by process name
    pkill -f "node.*server.js" 2>/dev/null || true
    sleep 2
}

# Start Node.js App
start_node_app() {
    echo "Starting Node.js app (WiFi is managed by Node.js)..."
    cd "$BASE_DIR" || { echo "Failed to navigate to Node.js app directory"; return 1; }
    
    # Kill any existing node processes first
    kill_existing_node_processes
    
    # Check if package.json exists
    if [[ ! -f "package.json" ]]; then
        echo "Error: package.json not found in $BASE_DIR"
        return 1
    fi
    
    # Check if server.js exists
    if [[ ! -f "server.js" ]]; then
        echo "Error: server.js not found in $BASE_DIR"
        return 1
    fi
    
    # Wait a moment to ensure port is free
    sleep 2
    
    # Start the node app
    node server.js > "$BASE_DIR/logs/node_app.log" 2>&1 &
    local node_pid=$!
    
    echo "Node.js app starting with PID: $node_pid"
    
    local max_attempts=20
    local attempt=1
    
    while [[ $attempt -le $max_attempts ]]; do
        if curl -s http://localhost:3006/health > /dev/null 2>&1; then
            echo "✅ Node.js app started successfully! (PID: $node_pid)"
            echo "Note: WiFi is now managed by the Node.js application"
            return 0
        fi
        
        # Check if process is still running
        if ! kill -0 $node_pid 2>/dev/null; then
            echo "Error: Node.js app process died"
            
            # Check for port conflict
            if lsof -ti:3006 > /dev/null 2>&1; then
                echo "Port 3006 is still in use. Force killing..."
                kill_existing_node_processes
                sleep 2
                # Retry once
                node server.js > "$BASE_DIR/logs/node_app.log" 2>&1 &
                node_pid=$!
                echo "Retried Node.js app with PID: $node_pid"
                continue
            fi
            
            return 1
        fi
        
        echo "Attempt $attempt: Node.js app not ready yet, retrying..."
        sleep 3
        ((attempt++))
    done
    
    echo "Warning: Node.js app not responding after 60 seconds, but process is still running"
    return 0
}

# Function to reload MPV playlist
reload_mpv_playlist() {
    echo "Reloading MPV playlist..."
    
    # Check if MPV is running and socket exists
    if [[ -S "$MPV_SOCKET" ]]; then
        # Check if socat is available
        if command -v socat &> /dev/null; then
            # Send command to MPV to reload playlist
            echo '{ "command": ["loadlist", "'"$PLAYLIST"'", "replace"] }' | socat - "$MPV_SOCKET" 2>/dev/null
            
            if [[ $? -eq 0 ]]; then
                echo "MPV playlist reloaded successfully"
                return 0
            else
                echo "Failed to communicate with MPV socket"
            fi
        fi
    else
        echo "MPV socket not found: $MPV_SOCKET"
    fi
    
    return 1
}

# Function to update the playlist with MPV reload
update_playlist() {
    echo "Updating playlist..."
    
    # Store old playlist hash for comparison
    local old_hash=""
    if [[ -f "$PLAYLIST" ]]; then
        old_hash=$(md5sum "$PLAYLIST" 2>/dev/null | cut -d' ' -f1)
    fi
    
    # Create playlist file if it doesn't exist
    touch "$PLAYLIST"
    
    if [[ -d "$VIDEO_DIR" ]]; then
        # Find all video files and create playlist
        find "$VIDEO_DIR" -type f \( -name "*.mp4" -o -name "*.avi" -o -name "*.mkv" -o -name "*.mov" -o -name "*.MP4" -o -name "*.AVI" -o -name "*.MKV" -o -name "*.MOV" \) > "$PLAYLIST.tmp"
        
        # Remove empty lines and sort
        grep -v '^$' "$PLAYLIST.tmp" | sort > "$PLAYLIST"
        rm -f "$PLAYLIST.tmp"
        
        local video_count=$(wc -l < "$PLAYLIST" 2>/dev/null || echo 0)
        echo "Playlist updated: $video_count videos found."
        
        # List videos for debugging
        if [[ $video_count -gt 0 ]]; then
            echo "Videos in playlist:"
            head -5 "$PLAYLIST"  # Show first 5 only
            if [[ $video_count -gt 5 ]]; then
                echo "... and $((video_count - 5)) more"
            fi
        else
            echo "Warning: No video files found in $VIDEO_DIR"
            echo "Supported formats: mp4, avi, mkv, mov"
            # Create empty playlist to avoid errors
            echo "# Empty playlist - waiting for videos" > "$PLAYLIST"
        fi
    else
        echo "Video directory not found: $VIDEO_DIR"
        mkdir -p "$VIDEO_DIR"
        echo "Created video directory: $VIDEO_DIR"
        # Create empty playlist
        echo "# Empty playlist - waiting for videos" > "$PLAYLIST"
    fi
    
    # Force playlist file permissions
    chmod 644 "$PLAYLIST"
    
    # Check if playlist actually changed
    local new_hash=$(md5sum "$PLAYLIST" 2>/dev/null | cut -d' ' -f1)
    
    if [[ "$old_hash" != "$new_hash" ]]; then
        echo "Playlist changed - reloading MPV..."
        if ! reload_mpv_playlist; then
            # If reload fails, restart MPV
            echo "Restarting MPV to load new playlist..."
            pkill -f mpv 2>/dev/null || true
            sleep 2
            start_mpv
        fi
    else
        echo "Playlist unchanged"
    fi
}

# Start MPV for video playback
start_mpv() {
    echo "Starting MPV playback..."
    
    # Check if MPV is installed
    if ! command -v mpv &> /dev/null; then
        echo "Error: MPV is not installed. Video playback disabled."
        echo "Install MPV with: sudo apt-get install mpv"
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
    sleep 3
    
    # Kill any existing MPV processes
    pkill -f mpv 2>/dev/null || true
    sleep 2
    
    # Ensure playlist exists and is updated
    update_playlist
    
    # Check if there are videos to play
    if [[ ! -f "$PLAYLIST" ]] || [[ ! -s "$PLAYLIST" ]] || [[ $(wc -l < "$PLAYLIST" 2>/dev/null) -eq 0 ]]; then
        echo "No videos found in playlist. MPV will start but play nothing."
        # Create empty playlist file with comment
        echo "# Empty playlist - waiting for videos" > "$PLAYLIST"
    fi
    
    echo "Starting MPV with optimized configuration..."
    
    # Create MPV log directory
    mkdir -p "$BASE_DIR/logs"
    
    # Start MPV with Raspberry Pi optimized configuration
    mpv \
        --fs \
        --no-border \
        --ontop \
        --shuffle \
        --loop-playlist=inf \
        --osd-level=0 \
        --no-osc \
        --no-terminal \
        --input-ipc-server="$MPV_SOCKET" \
        --playlist="$PLAYLIST" \
        --keep-open=yes \
        --no-resume-playback \
        --hwdec=auto \
        --vo=gpu \
        --cache=yes \
        --cache-secs=30 \
        --quiet \
        --volume=80 \
        --no-audio-display \
        --really-quiet > "$BASE_DIR/logs/mpv.log" 2>&1 &
    
    local mpv_pid=$!
    
    echo "MPV started with IPC socket: $MPV_SOCKET (PID: $mpv_pid)"
    
    # Wait a bit to see if MPV starts successfully
    sleep 5
    
    # Check if MPV is running
    if kill -0 $mpv_pid 2>/dev/null; then
        echo "✅ MPV playback started successfully"
        return 0
    else
        echo "❌ MPV failed to start. Check logs: $BASE_DIR/logs/mpv.log"
        return 1
    fi
}

# Directory monitoring for video files
monitor_directory() {
    echo "Monitoring $VIDEO_DIR for changes..."
    
    # Check if inotifywait is available
    if ! command -v inotifywait &> /dev/null; then
        echo "Warning: inotifywait not available. Directory monitoring disabled."
        echo "Install inotify-tools: sudo apt-get install inotify-tools"
        
        # Fallback: periodic polling
        echo "Using periodic polling as fallback (every 30 seconds)..."
        while true; do
            sleep 30
            update_playlist
        done &
        return 0
    fi
    
    # Monitor directory
    {
        while true; do
            echo "Starting directory monitor..."
            
            # Monitor for file changes
            inotifywait -m -q -r \
                -e close_write \
                -e moved_to \
                -e delete \
                --format '%e %w%f' \
                "$VIDEO_DIR" 2>/dev/null | while read -r event file; do
                
                echo "[$(date '+%H:%M:%S')] Event: $event | File: $(basename "$file")"
                
                # Skip temporary files and playlist.txt
                if [[ "$file" =~ \.(tmp|part|download|crdownload)$ ]] || [[ "$file" == *"playlist.txt" ]]; then
                    continue
                fi
                
                # Check if it's a video file
                if [[ "$file" =~ \.(mp4|avi|mkv|mov|MP4|AVI|MKV|MOV)$ ]]; then
                    echo "✅ Video file detected: $(basename "$file")"
                    
                    # Wait a moment for file to be fully written
                    sleep 2
                    
                    # Update playlist
                    update_playlist
                fi
            done
            
            # If inotifywait exits, restart it
            echo "inotifywait exited, restarting in 5 seconds..."
            sleep 5
        done
    } &
    
    echo "✅ Directory monitoring started"
}

# Periodic playlist refresh (safety net)
start_periodic_playlist_refresh() {
    echo "Starting periodic playlist refresh (every 2 minutes)..."
    while true; do
        sleep 120  # 2 minutes
        update_playlist
    done &
}

# Function to display system status
show_system_status() {
    echo ""
    echo "=========================================="
    echo "SYSTEM STATUS"
    echo "=========================================="
    
    # Node.js app status
    if curl -s http://localhost:3006/health > /dev/null 2>&1; then
        echo "Node.js App: ✅ RUNNING"
        echo "WiFi Management: ✅ HANDLED BY NODE.JS"
    else
        echo "Node.js App: ❌ STOPPED"
        echo "WiFi Management: ❌ NOT AVAILABLE"
    fi
    
    # MPV status
    if pgrep -f mpv > /dev/null; then
        echo "Video Playback: ✅ RUNNING"
    else
        echo "Video Playback: ❌ STOPPED"
    fi
    
    # X server status
    if is_xserver_running; then
        echo "X Server: ✅ RUNNING"
    else
        echo "X Server: ❌ STOPPED"
    fi
    
    # Video count
    if [[ -f "$PLAYLIST" ]]; then
        local video_count=$(wc -l < "$PLAYLIST" 2>/dev/null || echo 0)
        echo "Videos in Playlist: $video_count"
    fi
    
    echo "=========================================="
    echo ""
}

# Main startup sequence
main() {
    echo "Starting ADS Display System..."
    echo "Note: WiFi connection is managed by the Node.js application"
    
    # Wait a moment
    sleep 2
    
    # Start Node.js application (handles WiFi)
    if ! start_node_app; then
        echo "Failed to start Node.js app, will retry..."
        sleep 10
        start_node_app
    fi
    
    # For Lite version, start X server
    if is_lite_version; then
        echo "Lite version detected - starting X server..."
        start_xserver
        sleep 5
    fi
    
    # Initial playlist creation
    echo "Setting up video playback..."
    update_playlist
    
    # Start MPV playback (only if X server is available)
    if is_xserver_running; then
        if ! start_mpv; then
            echo "Failed to start MPV, will retry in 10 seconds..."
            sleep 10
            start_mpv
        fi
    else
        echo "X server not available - video playback disabled"
        echo "Videos will be downloaded and stored for when display is available"
    fi
    
    # Monitor directory for changes
    monitor_directory
    
    # Start periodic playlist refresh (safety net)
    start_periodic_playlist_refresh
    
    # Show final status
    show_system_status
    
    echo "✅ ADS Display System Started Successfully"
    echo ""
    echo "Access Points:"
    echo "  - Local: http://localhost:3006"
    echo "  - Health: http://localhost:3006/health"
    echo "  - WiFi: Managed by Node.js application"
    echo ""
    echo "Log Files:"
    echo "  - System: $LOG_FILE"
    echo "  - Node.js: $BASE_DIR/logs/node_app.log"
    echo "  - MPV: $BASE_DIR/logs/mpv.log"
    echo ""
    echo "Press Ctrl+C to stop the system"
    echo "=========================================="
    
    # Keep script running and monitor processes
    while true; do
        # Check if Node.js app is still running
        if ! pgrep -f "node.*server.js" > /dev/null; then
            echo "Warning: Node.js app stopped. Restarting..."
            start_node_app
        fi
        
        # Check if MPV is still running (only if X server is available)
        if is_xserver_running && ! pgrep -f mpv > /dev/null; then
            echo "Warning: MPV stopped. Restarting..."
            start_mpv
        fi
        
        # Show status periodically (every 5 minutes)
        sleep 300
        show_system_status
    done
}

# Error handling
handle_error() {
    echo "Error occurred in ADS Display startup script!"
    echo "Error details: $1"
    echo "Check the log file for more details: $LOG_FILE"
    
    # Try to restart main function after a delay
    sleep 10
    echo "Attempting to restart..."
    main
}

# Set error trap
trap 'handle_error "Script terminated unexpectedly at line $LINENO"' ERR
trap 'echo "Received SIGINT, stopping..."; exit 0' INT

# Run main function
main