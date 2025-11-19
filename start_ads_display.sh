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

# Function to wait for X server (for Lite version)
wait_for_xserver() {
    if is_lite_version; then
        echo "Lite version detected - waiting for X server..."
        local max_attempts=30
        local attempt=1
        
        while [[ $attempt -le $max_attempts ]]; do
            if xset -q > /dev/null 2>&1; then
                echo "X server is ready (attempt $attempt)"
                return 0
            fi
            echo "Waiting for X server... (attempt $attempt/$max_attempts)"
            sleep 2
            ((attempt++))
        done
        
        echo "Warning: X server not ready after $max_attempts attempts"
        return 1
    fi
    return 0
}

# Function to display a black screen
show_black_screen() {
    echo "Displaying a black screen..."
    
    # Wait for X server first
    wait_for_xserver
    
    # Set black background
    xsetroot -solid black 2>/dev/null || echo "Warning: Could not set black screen"
    
    # Hide mouse pointer if X is available
    if command -v unclutter &> /dev/null && xset -q > /dev/null 2>&1; then
        unclutter -idle 0.1 -root &
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
        echo "Current implementation requires manual WiFi connection setup"
    else
        echo "No WiFi configuration found in device config"
        echo "Please configure WiFi via the admin dashboard"
    fi
    
    # Check current connection
    if ping -c 1 -W 2 google.com > /dev/null 2>&1; then
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
        if ! ping -c 1 -W 2 google.com > /dev/null 2>&1; then
            echo "Internet connection lost. Attempting to reconnect..."
            connect_to_configured_wifi
        fi
        sleep 300 # Check every 5 minutes
    done &
}

# Start ngrok and ensure it is running before proceeding
start_ngrok() {
    echo "Starting ngrok..."
    
    # Check if ngrok is installed
    if ! command -v ngrok &> /dev/null; then
        echo "Error: ngrok is not installed. Please run the installation script first."
        return 1
    fi
    
    # Kill any existing ngrok processes
    pkill -f ngrok || true
    sleep 2
    
    # Start ngrok in background
    ngrok http 3000 > /dev/null 2>&1 &
    local ngrok_pid=$!
    
    echo "Waiting for ngrok to be ready..."
    local max_attempts=30
    local attempt=1
    
    while [[ $attempt -le $max_attempts ]]; do
        if curl -s http://127.0.0.1:4040/api/tunnels > /dev/null 2>&1; then
            echo "ngrok started successfully! (PID: $ngrok_pid)"
            
            # Get public URL
            local public_url=$(curl -s http://127.0.0.1:4040/api/tunnels | grep -o '"public_url":"[^"]*"' | head -1 | cut -d'"' -f4)
            if [[ -n "$public_url" ]]; then
                echo "Public URL: $public_url"
            fi
            
            return 0
        fi
        echo "Attempt $attempt: ngrok not ready yet, retrying..."
        sleep 2
        ((attempt++))
    done
    
    echo "Error: ngrok failed to start within 60 seconds"
    return 1
}

# Start Node.js App and wait for it to stabilize
start_node_app() {
    echo "Starting Node.js app..."
    cd "$BASE_DIR" || { echo "Failed to navigate to Node.js app directory"; return 1; }
    
    # Kill any existing node processes for this app
    pkill -f "node server.js" || true
    sleep 2
    
    # Start the node app
    node server.js > /dev/null 2>&1 &
    local node_pid=$!
    
    local max_attempts=30
    local attempt=1
    
    while [[ $attempt -le $max_attempts ]]; do
        if curl -s http://localhost:3000/health > /dev/null 2>&1; then
            echo "Node.js app started successfully! (PID: $node_pid)"
            return 0
        fi
        echo "Attempt $attempt: Node.js app not ready yet, retrying..."
        sleep 2
        ((attempt++))
    done
    
    echo "Error: Node.js app failed to start within 60 seconds"
    return 1
}

# Function to update the playlist
update_playlist() {
    echo "Updating playlist..."
    if [[ -d "$VIDEO_DIR" ]]; then
        find "$VIDEO_DIR" -name "*.mp4" -o -name "*.avi" -o -name "*.mkv" -o -name "*.mov" > "$PLAYLIST"
        local video_count=$(wc -l < "$PLAYLIST" 2>/dev/null || echo 0)
        echo "Playlist updated: $video_count videos found."
        
        # List videos for debugging
        if [[ $video_count -gt 0 ]]; then
            echo "Videos in playlist:"
            cat "$PLAYLIST"
        fi
    else
        echo "Video directory not found: $VIDEO_DIR"
        mkdir -p "$VIDEO_DIR"
        echo "Created video directory: $VIDEO_DIR"
    fi
}

# Optimized MPV startup with faster initialization
start_mpv() {
    echo "Starting MPV playback with IPC..."
    
    # Check if MPV is installed
    if ! command -v mpv &> /dev/null; then
        echo "Error: MPV is not installed. Please run the installation script first."
        return 1
    fi
    
    # Wait for X server
    wait_for_xserver
    
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
    
    # Create MPV configuration for faster startup
    local MPV_CONFIG_DIR="/home/$USER/.config/mpv"
    mkdir -p "$MPV_CONFIG_DIR"
    
    cat > "$MPV_CONFIG_DIR/mpv.conf" << 'EOF'
# Faster startup and better performance
hwdec=auto-safe
vo=gpu
gpu-context=wayland,x11
profile=gpu-hq
scale=ewa_lanczossharp
dscale=mitchell
cscale=ewa_lanczossharp
video-sync=display-resample
interpolation
tscale=oversample
hwdec-codecs=all

# Performance optimizations
cache=yes
cache-secs=300
demuxer-max-bytes=500M
demuxer-max-back-bytes=100M

# Input optimizations
input-ipc-server=/tmp/mpv-socket
input-builtin-bindings=yes
input-default-bindings=yes
input-vo-keyboard=no

# Skip frames to catch up after lag
framedrop=vo

# Network optimizations
ytdl=no
EOF

    echo "Starting MPV with optimized configuration..."
    
    # Start MPV with optimized parameters for faster startup
    mpv --fs \
        --shuffle \
        --loop-playlist=inf \
        --osd-level=0 \
        --no-terminal \
        --input-ipc-server="$MPV_SOCKET" \
        --playlist="$PLAYLIST" \
        --keep-open=yes \
        --no-resume-playback \
        --cache=yes \
        --cache-secs=300 \
        --hwdec=auto-safe \
        --vo=gpu \
        --profile=gpu-hq \
        >/dev/null 2>&1 &
    
    local mpv_pid=$!
    
    echo "MPV started with IPC socket: $MPV_SOCKET (PID: $mpv_pid)"
    
    # Wait for MPV to initialize and start playing
    local mpv_attempts=0
    local mpv_max_attempts=20
    
    while [[ $mpv_attempts -lt $mpv_max_attempts ]]; do
        if [[ -S "$MPV_SOCKET" ]]; then
            echo "MPV IPC socket is ready (attempt $((mpv_attempts + 1)))"
            
            # Test if MPV is responsive
            if echo '{ "command": ["get_property", "pause"] }' | socat - "$MPV_SOCKET" 2>/dev/null | grep -q "false"; then
                echo "MPV is playing videos successfully"
                return 0
            fi
        fi
        
        sleep 0.5
        ((mpv_attempts++))
    done
    
    echo "Warning: MPV startup taking longer than expected"
    return 0
}

# Reload MPV playlist dynamically without interrupting playback
reload_mpv_playlist() {
    if [[ -S "$MPV_SOCKET" ]]; then
        echo "Reloading playlist in MPV..."
        echo '{ "command": ["loadlist", "'"$PLAYLIST"'", "replace"] }' | socat - "$MPV_SOCKET"
    else
        echo "MPV is not running. Starting MPV..."
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
    
    inotifywait -m -e close_write -e delete --format '%w%f' "$VIDEO_DIR" | while read -r file; do
        if [[ "$file" == *.mp4 ]] || [[ "$file" == *.avi ]] || [[ "$file" == *.mkv ]] || [[ "$file" == *.mov ]]; then
            echo "Video file change detected: $file"
            sleep 2 # Small delay to allow for multiple changes
            update_playlist
            reload_mpv_playlist
        fi
    done &
}

# Preload videos to cache for faster playback
preload_videos() {
    echo "Preloading videos for faster playback..."
    
    if [[ -f "$PLAYLIST" ]] && [[ -s "$PLAYLIST" ]]; then
        local first_video=$(head -n1 "$PLAYLIST")
        if [[ -f "$first_video" ]]; then
            echo "Preloading first video: $first_video"
            # This helps MPV cache the first video
            mpv --fs --no-video --input-ipc-server="$MPV_SOCKET" "$first_video" >/dev/null 2>&1 &
            local preload_pid=$!
            sleep 2
            kill $preload_pid 2>/dev/null
        fi
    fi
}

# Main startup sequence
main() {
    echo "Starting ADS Display System..."
    
    # Show black screen immediately
    show_black_screen
    
    # Wait for network to stabilize (reduced time)
    echo "Waiting for network initialization..."
    sleep 5
    
    # Connect to configured WiFi
    echo "Setting up network connection..."
    connect_to_configured_wifi
    
    # Start WiFi monitoring
    monitor_wifi
    
    # Start ngrok tunnel
    echo "Initializing ngrok tunnel..."
    start_ngrok
    
    # Start Node.js application
    echo "Starting application server..."
    start_node_app
    
    # Initial playlist creation
    echo "Setting up video playback..."
    update_playlist
    
    # Preload videos for faster startup
    preload_videos
    
    # Start MPV playback
    start_mpv
    
    # Monitor directory for changes
    monitor_directory
    
    echo "=========================================="
    echo "ADS Display System Started Successfully"
    echo "User: $USERNAME"
    echo "Base Directory: $BASE_DIR"
    echo "Time: $(date)"
    echo "=========================================="
    
    # Keep script running
    wait
}

# Error handling
handle_error() {
    echo "Error occurred in ADS Display startup script!"
    echo "Error details: $1"
    echo "Check the log file for more details: $LOG_FILE"
    exit 1
}

# Set error trap
trap 'handle_error "Script terminated unexpectedly"' ERR

# Run main function
main