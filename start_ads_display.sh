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
WIFI_CONFIG_FILE="$BASE_DIR/config/wifi-config.json"

# Get current username
USERNAME=$(whoami)

# Ensure directories exist
mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$(dirname "$CONFIG_FILE")"
mkdir -p "$(dirname "$WIFI_CONFIG_FILE")"
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
        sudo X :0 -ac -nocursor -retro > /dev/null 2>&1 &
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

# Function to scan for available WiFi networks
scan_wifi_networks() {
    echo "Scanning for available WiFi networks..."
    
    if ! command -v nmcli &> /dev/null; then
        echo "NetworkManager not available for scanning"
        return 1
    fi
    
    # Scan for networks
    nmcli device wifi rescan 2>/dev/null
    sleep 5
    
    # List available networks
    local available_networks=$(nmcli -t -f SSID device wifi list | sort | uniq)
    
    if [[ -n "$available_networks" ]]; then
        echo "Available WiFi networks:"
        echo "$available_networks"
        return 0
    else
        echo "No WiFi networks found"
        return 1
    fi
}

# Function to create default WiFi configuration
create_default_wifi_config() {
    echo "Creating default WiFi configuration..."
    
    # First, scan for available networks to suggest
    scan_wifi_networks
    
    local default_config='{
        "ssid": "spotus",
        "password": "spotus123",
        "is_default": true,
        "auto_connect": true,
        "created_at": "'$(date -Iseconds)'",
        "updated_at": "'$(date -Iseconds)'"
    }'
    
    echo "$default_config" > "$WIFI_CONFIG_FILE"
    chmod 600 "$WIFI_CONFIG_FILE"
    echo "Empty WiFi configuration created. Configure via web interface."
}

# Function to read WiFi configuration from device config
get_configured_wifi() {
    # First check WiFi config file
    if [[ -f "$WIFI_CONFIG_FILE" ]]; then
        local ssid=$(grep -o '"ssid": *"[^"]*"' "$WIFI_CONFIG_FILE" | cut -d'"' -f4)
        local password=$(grep -o '"password": *"[^"]*"' "$WIFI_CONFIG_FILE" | cut -d'"' -f4)
        local auto_connect=$(grep -o '"auto_connect": *\(true\|false\)' "$WIFI_CONFIG_FILE" | grep -o '\(true\|false\)')
        
        if [[ -n "$ssid" && -n "$password" && "$auto_connect" == "true" ]]; then
            echo "$ssid|$password"
            return 0
        fi
    fi
    
    return 1
}

# Function to connect to WiFi using nmcli
connect_to_wifi() {
    local ssid="$1"
    local password="$2"
    
    echo "Attempting to connect to WiFi: $ssid"
    
    # Check if NetworkManager is available
    if ! command -v nmcli &> /dev/null; then
        echo "Error: NetworkManager (nmcli) not available"
        return 1
    fi
    
    # Check if SSID exists in available networks
    if ! nmcli -t -f SSID device wifi list | grep -q "^$ssid$"; then
        echo "Error: WiFi network '$ssid' not found in available networks"
        echo "Available networks:"
        nmcli -t -f SSID device wifi list | sort | uniq
        return 1
    fi
    
    # Check if already connected to this SSID
    local current_ssid=$(nmcli -t -f active,ssid dev wifi | grep yes: | cut -d: -f2)
    if [[ "$current_ssid" == "$ssid" ]]; then
        echo "Already connected to $ssid"
        return 0
    fi
    
    # Try to connect
    echo "Connecting to $ssid..."
    local connect_output
    connect_output=$(nmcli device wifi connect "$ssid" password "$password" 2>&1)
    local connect_result=$?
    
    if [ $connect_result -eq 0 ]; then
        echo "Successfully connected to $ssid"
        
        # Wait for connection to stabilize
        sleep 5
        
        # Verify connection
        if nmcli -t -f general.state con show "$ssid" 2>/dev/null | grep -q activated; then
            echo "WiFi connection verified: $ssid"
            return 0
        else
            echo "Warning: Connection to $ssid may not be active"
            return 1
        fi
    else
        echo "Failed to connect to $ssid: $connect_output"
        return 1
    fi
}

# Function to Connect to configured WiFi with retry logic
connect_to_configured_wifi() {
    echo "Setting up WiFi connection..."
    
    # Create default config if it doesn't exist
    if [[ ! -f "$WIFI_CONFIG_FILE" ]]; then
        create_default_wifi_config
        echo "No WiFi configuration set. Please configure via web interface."
        return 1
    fi
    
    # Get WiFi configuration
    local wifi_config=$(get_configured_wifi)
    if [[ -z "$wifi_config" ]]; then
        echo "No auto-connect WiFi configuration found."
        echo "Available networks:"
        scan_wifi_networks
        return 1
    fi
    
    local ssid=$(echo "$wifi_config" | cut -d'|' -f1)
    local password=$(echo "$wifi_config" | cut -d'|' -f2)
    
    if [[ -z "$ssid" || -z "$password" ]]; then
        echo "Error: Invalid WiFi configuration"
        return 1
    fi
    
    echo "Found auto-connect WiFi configuration: SSID=$ssid"
    
    # Check current connection
    local current_ssid=$(nmcli -t -f active,ssid dev wifi | grep yes: | cut -d: -f2)
    if [[ "$current_ssid" == "$ssid" ]]; then
        echo "Already connected to configured WiFi: $ssid"
        
        # Test internet connectivity
        if ping -c 1 -W 3 8.8.8.8 > /dev/null 2>&1; then
            echo "Internet connection verified"
            return 0
        else
            echo "Connected to $ssid but no internet access"
        fi
    fi
    
    # Attempt to connect with retry logic
    local max_attempts=2
    local attempt=1
    
    while [[ $attempt -le $max_attempts ]]; do
        echo "WiFi connection attempt $attempt of $max_attempts..."
        
        if connect_to_wifi "$ssid" "$password"; then
            # Test internet after connection
            if ping -c 1 -W 3 8.8.8.8 > /dev/null 2>&1; then
                echo "Internet connection established via $ssid"
                return 0
            else
                echo "Connected to $ssid but no internet access"
            fi
        fi
        
        ((attempt++))
        if [[ $attempt -le $max_attempts ]]; then
            echo "Retrying in 5 seconds..."
            sleep 5
        fi
    done
    
    echo "Failed to connect to WiFi after $max_attempts attempts"
    return 1
}

# Function to check if Node.js app is already running
is_node_app_running() {
    if curl -s http://localhost:3006/health > /dev/null 2>&1; then
        return 0
    fi
    
    # Alternative check using process
    if pgrep -f "node.*server.js" > /dev/null; then
        return 0
    fi
    
    return 1
}

# Function to kill existing Node.js processes on port 3006
kill_existing_node_processes() {
    echo "Checking for existing Node.js processes on port 3006..."
    
    # Find PIDs using port 3006
    local port_pids=$(lsof -ti:3006 2>/dev/null)
    if [[ -n "$port_pids" ]]; then
        echo "Killing processes using port 3006: $port_pids"
        kill -9 $port_pids 2>/dev/null || true
        sleep 2
    fi
    
    # Kill any node processes for our app
    local node_pids=$(pgrep -f "node.*server.js" 2>/dev/null)
    if [[ -n "$node_pids" ]]; then
        echo "Killing existing Node.js processes: $node_pids"
        kill -9 $node_pids 2>/dev/null || true
        sleep 2
    fi
    
    # Double check
    if pgrep -f "node.*server.js" > /dev/null; then
        echo "Force killing any remaining Node.js processes..."
        pkill -9 -f "node.*server.js" 2>/dev/null || true
        sleep 2
    fi
}

# Start a Background WiFi Monitor
monitor_wifi() {
    echo "Starting WiFi monitor..."
    while true; do
        # Check internet connectivity
        if ! ping -c 1 -W 3 8.8.8.8 > /dev/null 2>&1; then
            echo "Internet connection lost. Attempting to reconnect..."
            connect_to_configured_wifi
        fi
        sleep 60 # Check every minute
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
    return 0
}

# Start Node.js App with better error handling
start_node_app() {
    echo "Starting Node.js app..."
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
    
    # Install dependencies if node_modules doesn't exist
    if [[ ! -d "node_modules" ]]; then
        echo "Installing Node.js dependencies..."
        npm install
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
            echo "Node.js app started successfully! (PID: $node_pid)"
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
            
            # Try to get error output
            if [[ -f "$BASE_DIR/logs/node_app.log" ]]; then
                echo "Last log entries:"
                tail -20 "$BASE_DIR/logs/node_app.log"
            fi
            
            return 1
        fi
        
        echo "Attempt $attempt: Node.js app not ready yet, retrying..."
        sleep 3
        ((attempt++))
    done
    
    echo "Warning: Node.js app not responding after 60 seconds, but process is still running"
    echo "Check logs at: $BASE_DIR/logs/node_app.log"
    return 0
}

# Function to update the playlist - IMPROVED with better detection
update_playlist() {
    echo "Updating playlist..."
    
    # Create playlist file if it doesn't exist
    touch "$PLAYLIST"
    
    if [[ -d "$VIDEO_DIR" ]]; then
        # Find all video files and create playlist
        find "$VIDEO_DIR" -type f \( -name "*.mp4" -o -name "*.avi" -o -name "*.mkv" -o -name "*.mov" \) > "$PLAYLIST.tmp"
        
        # Remove empty lines and sort
        grep -v '^$' "$PLAYLIST.tmp" | sort > "$PLAYLIST"
        rm -f "$PLAYLIST.tmp"
        
        local video_count=$(wc -l < "$PLAYLIST" 2>/dev/null || echo 0)
        echo "Playlist updated: $video_count videos found."
        
        # List videos for debugging
        if [[ $video_count -gt 0 ]]; then
            echo "Videos in playlist:"
            cat "$PLAYLIST"
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
    echo "Playlist file created/updated: $PLAYLIST"
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
    
    # Ensure playlist exists and is updated
    update_playlist
    
    # Check if there are videos to play
    if [[ ! -f "$PLAYLIST" ]] || [[ ! -s "$PLAYLIST" ]] || [[ $(wc -l < "$PLAYLIST" 2>/dev/null) -eq 0 ]]; then
        echo "No videos found in playlist. MPV will start but play nothing."
        # Create empty playlist file with comment
        echo "# Empty playlist - waiting for videos" > "$PLAYLIST"
    fi
    
    echo "Starting MPV with optimized configuration..."
    
    # Start MPV
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
    echo "MPV playback started successfully"
    return 0
}

# IMPROVED Directory monitoring with better file detection
monitor_directory() {
    echo "Monitoring $VIDEO_DIR for changes..."
    
    # Check if inotifywait is available
    if ! command -v inotifywait &> /dev/null; then
        echo "Warning: inotifywait not available. Directory monitoring disabled."
        echo "Install inotify-tools for automatic directory monitoring."
        
        # Fallback: periodic polling
        echo "Using periodic polling as fallback (every 30 seconds)..."
        while true; do
            sleep 30
            update_playlist
        done &
        return 0
    fi
    
    # Create a more robust monitoring loop
    while true; do
        inotifywait -r -e create -e modify -e moved_to -e close_write --format '%w%f' "$VIDEO_DIR" | while read -r file; do
            echo "File change detected: $file"
            
            # Check if it's a video file
            if [[ "$file" =~ \.(mp4|avi|mkv|mov)$ ]]; then
                echo "Video file detected: $file"
                sleep 2
                update_playlist
            fi
        done
        sleep 10
    done &
}

# Additional function: Periodic playlist refresh (safety net)
start_periodic_playlist_refresh() {
    echo "Starting periodic playlist refresh (every 2 minutes)..."
    while true; do
        sleep 120  # 2 minutes
        update_playlist
    done &
}

# Main startup sequence
main() {
    echo "Starting ADS Display System..."
    
    # Wait for network to stabilize
    echo "Waiting for network initialization..."
    sleep 5
    
    # Connect to configured WiFi (non-blocking)
    connect_to_configured_wifi &
    
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
    
    # Start periodic playlist refresh (safety net)
    start_periodic_playlist_refresh
    
    echo "=========================================="
    echo "ADS Display System Started Successfully"
    echo "User: $USERNAME"
    echo "Base Directory: $BASE_DIR"
    echo "Time: $(date)"
    echo "WiFi: Configure via web interface"
    echo "Playlist monitoring: ACTIVE"
    echo "Health check: http://localhost:3006/health"
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