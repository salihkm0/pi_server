#!/bin/bash

# ADS Display Startup Script
# Dynamic WiFi configuration and video playback
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
CONFIG_FILE="$BASE_DIR/config/device-config.json"

# Get current username
USERNAME=$(whoami)

# Ensure directories exist
mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$(dirname "$CONFIG_FILE")"
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

# Function to start X server for Lite version with better error handling
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
        
        # Start X server with proper configuration for headless mode
        sudo X :0 -ac -nocursor -retro -config /etc/X11/xorg.conf.headless > /dev/null 2>&1 &
        local xserver_pid=$!
        
        echo "X server started with PID: $xserver_pid"
        
        # Wait for X server to be ready with better detection
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
                
                # Try alternative method
                startx -- -nocursor -retro > /dev/null 2>&1 &
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

# Function to display a black screen
show_black_screen() {
    echo "Displaying a black screen..."
    
    # Start X server first for Lite version
    if is_lite_version; then
        start_xserver
    fi
    
    # Wait a bit for X server to stabilize
    sleep 3
    
    # Set black background
    if is_xserver_running; then
        xsetroot -solid black 2>/dev/null && echo "Black screen set successfully"
        
        # Hide mouse pointer if X is available
        if command -v unclutter &> /dev/null; then
            unclutter -idle 0.1 -root &
            echo "Mouse pointer hidden"
        fi
    else
        echo "Warning: Cannot set black screen - X server not available"
    fi
}

# Function to read WiFi configuration from device config
get_configured_wifi() {
    if [[ -f "$CONFIG_FILE" ]]; then
        local ssid=$(grep -o '"ssid": *"[^"]*"' "$CONFIG_FILE" | cut -d'"' -f4)
        if [[ -n "$ssid" ]]; then
            echo "$ssid"
            return 0
        fi
    fi
    return 1
}

# Function to Connect to WiFi with dynamic configuration
connect_to_configured_wifi() {
    local ssid=$(get_configured_wifi)
    
    if [[ -n "$ssid" ]]; then
        echo "Found configured WiFi in device config: $ssid"
        echo "Note: WiFi password should be configured via admin dashboard"
    else
        echo "No WiFi configuration found in device config"
        echo "Please configure WiFi via the admin dashboard"
    fi
    
    # Check current connection
    if ping -c 1 -W 2 8.8.8.8 > /dev/null 2>&1; then
        local current_ssid=$(nmcli -t -f active,ssid dev wifi | grep yes: | cut -d: -f2)
        echo "Currently connected to: $current_ssid"
        return 0
    else
        echo "No internet connection available"
        return 1
    fi
}

# Start a Background WiFi Monitor
monitor_wifi() {
    echo "Starting WiFi monitor..."
    while true; do
        if ! ping -c 1 -W 2 8.8.8.8 > /dev/null 2>&1; then
            echo "Internet connection lost. Attempting to reconnect..."
            connect_to_configured_wifi
        fi
        sleep 300 # Check every 5 minutes
    done &
}

# Improved ngrok handling with free trial support
start_ngrok() {
    echo "Checking ngrok..."
    
    # Check if ngrok is installed
    if ! command -v ngrok &> /dev/null; then
        echo "Warning: ngrok is not installed. Skipping ngrok tunnel."
        echo "To enable ngrok, install it with: ngrok config add-authtoken <YOUR_TOKEN>"
        return 0
    fi
    
    # Check if authtoken is configured
    if ! ngrok config check > /dev/null 2>&1; then
        echo "Warning: ngrok authtoken not configured. Skipping ngrok tunnel."
        echo "Configure with: ngrok config add-authtoken <YOUR_TOKEN>"
        return 0
    fi
    
    echo "Starting ngrok tunnel for port 3006..."
    
    # Kill any existing ngrok processes
    pkill -f ngrok || true
    sleep 2
    
    # Start ngrok in background with specific configuration
    ngrok http 3006 --log=stdout > "$BASE_DIR/logs/ngrok.log" 2>&1 &
    local ngrok_pid=$!
    
    echo "ngrok started with PID: $ngrok_pid"
    
    # Wait for ngrok to initialize (shorter timeout for free trial)
    local max_attempts=10
    local attempt=1
    
    while [[ $attempt -le $max_attempts ]]; do
        # Try multiple endpoints
        if curl -s http://127.0.0.1:4040/api/tunnels > /dev/null 2>&1 || \
           curl -s http://localhost:4040/api/tunnels > /dev/null 2>&1; then
            echo "ngrok started successfully! (PID: $ngrok_pid)"
            
            # Get public URL with error handling
            local public_url=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | grep -o '"public_url":"[^"]*"' | head -1 | cut -d'"' -f4)
            
            if [[ -z "$public_url" ]]; then
                public_url=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | grep -o '"public_url":"[^"]*"' | head -1 | cut -d'"' -f4)
            fi
            
            if [[ -n "$public_url" ]]; then
                echo "Public URL: $public_url"
            else
                echo "Warning: Could not retrieve public URL from ngrok"
            fi
            
            return 0
        fi
        
        # Check if ngrok process is still running
        if ! kill -0 $ngrok_pid 2>/dev/null; then
            echo "Warning: ngrok process died. Check ngrok configuration."
            echo "For free trial, ensure your account has active tunnels available."
            return 1
        fi
        
        echo "Attempt $attempt: ngrok not ready yet, retrying..."
        sleep 3
        ((attempt++))
    done
    
    echo "Warning: ngrok failed to start within 30 seconds."
    echo "This is normal for free trial accounts with limited resources."
    echo "Continuing without ngrok tunnel..."
    
    # Don't kill ngrok - let it continue starting in background
    return 0
}

# Quick ngrok status check (non-blocking)
check_ngrok_status() {
    # Quick check without waiting
    if curl -s --connect-timeout 2 http://127.0.0.1:4040/api/tunnels > /dev/null 2>&1; then
        local public_url=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | grep -o '"public_url":"[^"]*"' | head -1 | cut -d'"' -f4)
        if [[ -n "$public_url" ]]; then
            echo "$public_url"
            return 0
        fi
    fi
    return 1
}

# Start Node.js App with better error handling
start_node_app() {
    echo "Starting Node.js app..."
    cd "$BASE_DIR" || { echo "Failed to navigate to Node.js app directory"; return 1; }
    
    # Kill any existing node processes for this app
    pkill -f "node.*server.js" || true
    sleep 2
    
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
    
    # Install dependencies if node_modules doesn't exist
    if [[ ! -d "node_modules" ]]; then
        echo "Installing Node.js dependencies..."
        npm install
    fi
    
    # Start the node app with more verbose logging initially
    node server.js &
    local node_pid=$!
    
    echo "Node.js app starting with PID: $node_pid"
    
    local max_attempts=15
    local attempt=1
    
    while [[ $attempt -le $max_attempts ]]; do
        if curl -s http://localhost:3006/health > /dev/null 2>&1; then
            echo "Node.js app started successfully! (PID: $node_pid)"
            return 0
        fi
        
        # Check if process is still running
        if ! kill -0 $node_pid 2>/dev/null; then
            echo "Error: Node.js app process died"
            
            # Try to get error output
            if [[ -f "$LOG_FILE" ]]; then
                echo "Last log entries:"
                tail -10 "$LOG_FILE"
            fi
            
            return 1
        fi
        
        echo "Attempt $attempt: Node.js app not ready yet, retrying..."
        sleep 3
        ((attempt++))
    done
    
    echo "Warning: Node.js app not responding after 45 seconds, but process is still running"
    echo "App may be starting slowly. Continuing..."
    return 0
}

# Function to update the playlist
update_playlist() {
    echo "Updating playlist..."
    if [[ -d "$VIDEO_DIR" ]]; then
        find "$VIDEO_DIR" -type f \( -name "*.mp4" -o -name "*.avi" -o -name "*.mkv" -o -name "*.mov" \) > "$PLAYLIST"
        local video_count=$(wc -l < "$PLAYLIST" 2>/dev/null || echo 0)
        echo "Playlist updated: $video_count videos found."
        
        # List videos for debugging
        if [[ $video_count -gt 0 ]]; then
            echo "Videos in playlist:"
            cat "$PLAYLIST"
        else
            echo "Warning: No video files found in $VIDEO_DIR"
            echo "Supported formats: mp4, avi, mkv, mov"
        fi
    else
        echo "Video directory not found: $VIDEO_DIR"
        mkdir -p "$VIDEO_DIR"
        echo "Created video directory: $VIDEO_DIR"
    fi
}

# Optimized MPV startup with fallback options
start_mpv() {
    echo "Starting MPV playback..."
    
    # Check if MPV is installed
    if ! command -v mpv &> /dev/null; then
        echo "Error: MPV is not installed. Video playback disabled."
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
    
    # Ensure playlist exists
    update_playlist
    
    # Check if there are videos to play
    if [[ ! -f "$PLAYLIST" ]] || [[ ! -s "$PLAYLIST" ]]; then
        echo "No videos found in playlist. MPV will start but play nothing."
        # Create empty playlist file
        touch "$PLAYLIST"
    fi
    
    echo "Starting MPV with optimized configuration..."
    
    # Try different MPV configurations for better compatibility
    local mpv_success=0
    
    # Attempt 1: Standard configuration
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
            mpv_success=1
            break
        fi
        
        # Check if MPV process is still alive
        if ! kill -0 $mpv_pid 2>/dev/null; then
            echo "MPV process died, attempting alternative configuration..."
            break
        fi
        
        sleep 1
        ((mpv_attempts++))
    done
    
    # If first attempt failed, try fallback configuration
    if [[ $mpv_success -eq 0 ]]; then
        echo "Trying fallback MPV configuration..."
        pkill -f mpv || true
        sleep 2
        
        # Fallback: simpler configuration
        mpv --fs \
            --loop-playlist=inf \
            --no-osd-bar \
            --no-input-default-bindings \
            --playlist="$PLAYLIST" \
            --hwdec=mmal \
            --vo=drm \
            > "$BASE_DIR/logs/mpv_fallback.log" 2>&1 &
        
        local fallback_pid=$!
        echo "Fallback MPV started (PID: $fallback_pid)"
        
        # Quick check if fallback is running
        sleep 3
        if kill -0 $fallback_pid 2>/dev/null; then
            echo "Fallback MPV configuration successful"
            mpv_success=1
        fi
    fi
    
    if [[ $mpv_success -eq 1 ]]; then
        echo "MPV playback started successfully"
        return 0
    else
        echo "Warning: MPV startup issues detected, but process is running"
        return 0
    fi
}

# Reload MPV playlist dynamically without interrupting playback
reload_mpv_playlist() {
    if [[ -S "$MPV_SOCKET" ]] && command -v socat > /dev/null 2>&1; then
        echo "Reloading playlist in MPV..."
        echo '{ "command": ["loadlist", "'"$PLAYLIST"'", "replace"] }' | socat - "$MPV_SOCKET"
    else
        echo "MPV is not running or socat not available. Restarting MPV..."
        start_mpv
    fi
}

# Monitor directory for changes and update the playlist dynamically
monitor_directory() {
    echo "Monitoring $VIDEO_DIR for changes..."
    
    # Check if inotifywait is available
    if ! command -v inotifywait &> /dev/null; then
        echo "Warning: inotifywait not available. Directory monitoring disabled."
        echo "Install inotify-tools for automatic directory monitoring."
        return 1
    fi
    
    while true; do
        inotifywait -e close_write -e delete -e move --format '%w%f' "$VIDEO_DIR" | while read -r file; do
            if [[ "$file" == *.mp4 ]] || [[ "$file" == *.avi ]] || [[ "$file" == *.mkv ]] || [[ "$file" == *.mov ]]; then
                echo "Video file change detected: $file"
                sleep 2 # Small delay to allow for multiple changes
                update_playlist
                reload_mpv_playlist
            fi
        done
        sleep 1
    done &
}

# Main startup sequence
main() {
    echo "Starting ADS Display System..."
    
    # Show black screen immediately (this will start X server if needed)
    show_black_screen
    
    # Wait for network to stabilize
    echo "Waiting for network initialization..."
    sleep 5
    
    # Connect to configured WiFi
    echo "Setting up network connection..."
    connect_to_configured_wifi
    
    # Start WiFi monitoring
    monitor_wifi
    
    # Start ngrok tunnel (non-blocking)
    start_ngrok &
    
    # Start Node.js application
    start_node_app
    
    # Initial playlist creation
    echo "Setting up video playback..."
    update_playlist
    
    # Start MPV playback (only if X server is available)
    if is_xserver_running; then
        start_mpv
    else
        echo "X server not available - video playback disabled"
        echo "Videos will be downloaded and stored for when display is available"
    fi
    
    # Monitor directory for changes
    monitor_directory
    
    echo "=========================================="
    echo "ADS Display System Started Successfully"
    echo "User: $USERNAME"
    echo "Base Directory: $BASE_DIR"
    echo "Time: $(date)"
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
        
        # Periodic ngrok status check (non-blocking)
        if [[ $(($(date +%s) % 300)) -eq 0 ]]; then  # Every 5 minutes
            if check_ngrok_status; then
                echo "ngrok tunnel is active"
            fi
        fi
        
        sleep 10
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
trap 'handle_error "Script terminated unexpectedly"' ERR

# Run main function
main