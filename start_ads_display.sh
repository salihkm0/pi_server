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
WIFI_CONFIG_FILE="$BASE_DIR/config/.local_wifi.json"  # Changed to match new system

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

# Default WiFi credentials (fallback)
DEFAULT_WIFI_SSID="spotus"
DEFAULT_WIFI_PASSWORD="123456789"

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

# Function to create or update local WiFi configuration
create_or_update_local_wifi() {
    echo "Checking local WiFi configuration..."
    
    if [[ ! -f "$WIFI_CONFIG_FILE" ]]; then
        echo "Creating new local WiFi configuration..."
        
        local default_config='{
            "ssid": "'$DEFAULT_WIFI_SSID'",
            "password_encrypted": "",
            "source": "default",
            "priority": 3,
            "last_updated": "'$(date -Iseconds)'",
            "is_default": true,
            "note": "Auto-created default WiFi config"
        }'
        
        echo "$default_config" > "$WIFI_CONFIG_FILE"
        chmod 600 "$WIFI_CONFIG_FILE"
        echo "Created default WiFi configuration"
        
        # Also create a simple config for manual editing
        local manual_config="$BASE_DIR/config/wifi-config.json"
        echo '{
            "ssid": "'$DEFAULT_WIFI_SSID'",
            "password": "'$DEFAULT_WIFI_PASSWORD'",
            "note": "Edit this file to change WiFi settings"
        }' > "$manual_config"
        chmod 644 "$manual_config"
        
        echo "WiFi configuration files created. Edit $manual_config to change settings."
    else
        echo "Local WiFi configuration already exists"
        # Check if it's the old format and convert
        if grep -q '"ssid":' "$WIFI_CONFIG_FILE" && grep -q '"password":' "$WIFI_CONFIG_FILE"; then
            echo "Converting old WiFi config format to new format..."
            
            local old_ssid=$(grep -o '"ssid": *"[^"]*"' "$WIFI_CONFIG_FILE" | cut -d'"' -f4)
            local old_password=$(grep -o '"password": *"[^"]*"' "$WIFI_CONFIG_FILE" | cut -d'"' -f4)
            
            local new_config='{
                "ssid": "'$old_ssid'",
                "password_encrypted": "",
                "source": "manual_legacy",
                "priority": 2,
                "last_updated": "'$(date -Iseconds)'",
                "is_default": false,
                "note": "Converted from old format"
            }'
            
            echo "$new_config" > "$WIFI_CONFIG_FILE"
            chmod 600 "$WIFI_CONFIG_FILE"
            echo "Converted old WiFi config to new format"
        fi
    fi
}

# Function to get WiFi credentials from local config
get_wifi_from_local_config() {
    if [[ -f "$WIFI_CONFIG_FILE" ]]; then
        # Try to get SSID
        local ssid=$(grep -o '"ssid": *"[^"]*"' "$WIFI_CONFIG_FILE" | cut -d'"' -f4)
        
        # For new encrypted format, we can't decrypt in bash
        # So we'll check for manual config file
        local manual_config="$BASE_DIR/config/wifi-config.json"
        if [[ -f "$manual_config" ]]; then
            local manual_ssid=$(grep -o '"ssid": *"[^"]*"' "$manual_config" | cut -d'"' -f4)
            local manual_password=$(grep -o '"password": *"[^"]*"' "$manual_config" | cut -d'"' -f4)
            
            if [[ -n "$manual_ssid" && -n "$manual_password" ]]; then
                echo "$manual_ssid|$manual_password"
                return 0
            fi
        fi
        
        # Fallback to default if we have SSID but no password
        if [[ -n "$ssid" ]]; then
            echo "$ssid|$DEFAULT_WIFI_PASSWORD"
            return 0
        fi
    fi
    
    # Ultimate fallback
    echo "$DEFAULT_WIFI_SSID|$DEFAULT_WIFI_PASSWORD"
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
    
    # Check if already connected to this SSID
    local current_ssid=$(nmcli -t -f active,ssid dev wifi | grep yes: | cut -d: -f2 2>/dev/null || echo "")
    if [[ "$current_ssid" == "$ssid" ]]; then
        echo "Already connected to $ssid"
        
        # Test internet connectivity
        if check_internet; then
            echo "Internet connection verified"
            return 0
        else
            echo "Connected to $ssid but no internet access, will reconnect..."
        fi
    fi
    
    # First, try to delete existing connection to avoid conflicts
    echo "Cleaning up existing connection for $ssid..."
    nmcli connection delete "$ssid" 2>/dev/null || true
    sleep 2
    
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
            
            # Test internet
            if check_internet; then
                echo "Internet connection established"
                return 0
            else
                echo "Connected to WiFi but no internet access"
                return 1
            fi
        else
            echo "Warning: Connection to $ssid may not be active"
            return 1
        fi
    else
        echo "Failed to connect to $ssid: $connect_output"
        
        # If connection fails, try scanning first
        echo "Scanning for available networks..."
        nmcli device wifi rescan
        sleep 3
        
        # Try one more time
        echo "Retrying connection..."
        connect_output=$(nmcli device wifi connect "$ssid" password "$password" 2>&1)
        
        if [ $? -eq 0 ]; then
            echo "Successfully connected on retry: $ssid"
            sleep 5
            check_internet
            return 0
        else
            echo "Failed again to connect to $ssid"
            return 1
        fi
    fi
}

# Function to check internet connectivity
check_internet() {
    echo "Checking internet connectivity..."
    
    # Try multiple endpoints
    local endpoints=("8.8.8.8" "1.1.1.1" "google.com")
    
    for endpoint in "${endpoints[@]}"; do
        if ping -c 1 -W 3 "$endpoint" > /dev/null 2>&1; then
            echo "Internet connectivity confirmed via $endpoint"
            return 0
        fi
    done
    
    # Try curl as fallback
    if curl -s --connect-timeout 5 https://www.google.com > /dev/null 2>&1; then
        echo "Internet connectivity confirmed via HTTPS"
        return 0
    fi
    
    echo "No internet connectivity"
    return 1
}

# Function to Connect to configured WiFi with retry logic
connect_to_configured_wifi() {
    echo "Setting up WiFi connection..."
    
    # Create or update local WiFi config
    create_or_update_local_wifi
    
    # Get WiFi configuration
    local wifi_config=$(get_wifi_from_local_config)
    if [[ -z "$wifi_config" ]]; then
        echo "No WiFi configuration found, using defaults"
        wifi_config="$DEFAULT_WIFI_SSID|$DEFAULT_WIFI_PASSWORD"
    fi
    
    local ssid=$(echo "$wifi_config" | cut -d'|' -f1)
    local password=$(echo "$wifi_config" | cut -d'|' -f2)
    
    if [[ -z "$ssid" || -z "$password" ]]; then
        echo "Error: Invalid WiFi configuration"
        return 1
    fi
    
    echo "Using WiFi configuration: SSID=$ssid"
    
    # Check if we already have internet
    if check_internet; then
        echo "Internet already available, no need to reconnect"
        return 0
    fi
    
    # Scan for available networks first
    echo "Scanning for available WiFi networks..."
    if ! scan_wifi_networks; then
        echo "Could not scan WiFi networks, attempting connection anyway..."
    fi
    
    # Attempt to connect with retry logic
    local max_attempts=3
    local attempt=1
    
    while [[ $attempt -le $max_attempts ]]; do
        echo "WiFi connection attempt $attempt of $max_attempts..."
        
        if connect_to_wifi "$ssid" "$password"; then
            echo "WiFi connection successful"
            return 0
        fi
        
        ((attempt++))
        if [[ $attempt -le $max_attempts ]]; then
            echo "Retrying in 10 seconds..."
            sleep 10
        fi
    done
    
    echo "Failed to connect to WiFi after $max_attempts attempts"
    
    # Try default WiFi as last resort
    if [[ "$ssid" != "$DEFAULT_WIFI_SSID" ]]; then
        echo "Trying default WiFi as fallback..."
        if connect_to_wifi "$DEFAULT_WIFI_SSID" "$DEFAULT_WIFI_PASSWORD"; then
            echo "Connected to default WiFi"
            return 0
        fi
    fi
    
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
    
    # Function for WiFi monitoring
    wifi_monitor_loop() {
        local consecutive_failures=0
        local max_consecutive_failures=3
        
        while true; do
            # Check internet connectivity
            if check_internet; then
                consecutive_failures=0
                echo "WiFi Monitor: Internet OK"
            else
                ((consecutive_failures++))
                echo "WiFi Monitor: Internet lost (failure $consecutive_failures/$max_consecutive_failures)"
                
                if [[ $consecutive_failures -ge $max_consecutive_failures ]]; then
                    echo "WiFi Monitor: Attempting to reconnect..."
                    connect_to_configured_wifi
                    consecutive_failures=0
                fi
            fi
            
            sleep 60  # Check every minute
        done
    }
    
    # Start monitor in background
    wifi_monitor_loop &
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
    
    # Create ngrok config directory if it doesn't exist
    mkdir -p "$BASE_DIR/logs"
    
    # Start ngrok in background with specific configuration
    ngrok http 3006 --log=stdout > "$BASE_DIR/logs/ngrok.log" 2>&1 &
    local ngrok_pid=$!
    
    echo "ngrok started with PID: $ngrok_pid"
    
    # Wait a bit for ngrok to start
    sleep 5
    
    # Try to get public URL
    local max_attempts=10
    local attempt=1
    
    while [[ $attempt -le $max_attempts ]]; do
        if curl -s http://localhost:4040/api/tunnels 2>/dev/null | grep -q "public_url"; then
            echo "ngrok tunnel established"
            return 0
        fi
        
        # Check if process is still running
        if ! kill -0 $ngrok_pid 2>/dev/null; then
            echo "ngrok process died, checking logs..."
            if [[ -f "$BASE_DIR/logs/ngrok.log" ]]; then
                tail -20 "$BASE_DIR/logs/ngrok.log"
            fi
            return 1
        fi
        
        echo "Waiting for ngrok tunnel... (attempt $attempt/$max_attempts)"
        sleep 5
        ((attempt++))
    done
    
    echo "ngrok tunnel not established after $max_attempts attempts, but process is running"
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
            
            # Get and log health status
            local health_status=$(curl -s http://localhost:3006/health | head -c 500)
            echo "Health status: $health_status"
            
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
            head -10 "$PLAYLIST"  # Show first 10 only
            if [[ $video_count -gt 10 ]]; then
                echo "... and $((video_count - 10)) more"
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
        inotifywait -r -e create -e modify -e moved_to -e close_write --format '%w%f' "$VIDEO_DIR" 2>/dev/null | while read -r file; do
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

# Function to display system status
show_system_status() {
    echo ""
    echo "=========================================="
    echo "SYSTEM STATUS"
    echo "=========================================="
    
    # Internet status
    if check_internet; then
        echo "Internet: ✅ CONNECTED"
    else
        echo "Internet: ❌ DISCONNECTED"
    fi
    
    # WiFi status
    if command -v nmcli &> /dev/null; then
        local wifi_status=$(nmcli -t -f general.state con show --active 2>/dev/null | head -1)
        local wifi_ssid=$(nmcli -t -f active,ssid dev wifi | grep yes: | cut -d: -f2 2>/dev/null)
        if [[ -n "$wifi_status" ]]; then
            echo "WiFi: ✅ CONNECTED to $wifi_ssid"
        else
            echo "WiFi: ❌ DISCONNECTED"
        fi
    fi
    
    # Node.js app status
    if is_node_app_running; then
        echo "Node.js App: ✅ RUNNING"
    else
        echo "Node.js App: ❌ STOPPED"
    fi
    
    # MPV status
    if pgrep -f mpv > /dev/null; then
        echo "Video Playback: ✅ RUNNING"
    else
        echo "Video Playback: ❌ STOPPED"
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
    
    # Wait for network to stabilize
    echo "Waiting for network initialization..."
    sleep 5
    
    # Connect to configured WiFi (non-blocking)
    connect_to_configured_wifi
    
    # Show initial status
    show_system_status
    
    # Start WiFi monitoring
    monitor_wifi
    
    # Start ngrok tunnel (non-blocking)
    start_ngrok &
    
    # Start Node.js application
    if ! start_node_app; then
        echo "Failed to start Node.js app, retrying in 10 seconds..."
        sleep 10
        start_node_app
    fi
    
    # Initial playlist creation
    echo "Setting up video playback..."
    update_playlist
    
    # Start MPV playback (only if X server is available)
    if is_xserver_running; then
        if ! start_mpv; then
            echo "Failed to start MPV, will retry later"
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
    
    echo "ADS Display System Started Successfully"
    echo ""
    echo "Access Points:"
    echo "  - Local: http://localhost:3006"
    echo "  - Health: http://localhost:3006/health"
    echo "  - WiFi Config: Edit $BASE_DIR/config/wifi-config.json"
    echo ""
    echo "Log Files:"
    echo "  - System: $LOG_FILE"
    echo "  - Node.js: $BASE_DIR/logs/node_app.log"
    echo "  - MPV: $BASE_DIR/logs/mpv.log"
    echo ""
    echo "Press Ctrl+C to stop the system"
    echo "=========================================="
    
    # Keep script running and monitor processes
    local check_interval=30
    local status_counter=0
    
    while true; do
        # Periodic status display
        ((status_counter++))
        if [[ $status_counter -ge 10 ]]; then  # Every 5 minutes (30s * 10)
            show_system_status
            status_counter=0
        fi
        
        # Check if Node.js app is still running
        if ! pgrep -f "node.*server.js" > /dev/null; then
            echo "Warning: Node.js app stopped. Restarting..."
            if ! start_node_app; then
                echo "Failed to restart Node.js app, will retry later"
            fi
        fi
        
        # Check if MPV is still running (only if X server is available)
        if is_xserver_running && ! pgrep -f mpv > /dev/null; then
            echo "Warning: MPV stopped. Restarting..."
            if ! start_mpv; then
                echo "Failed to restart MPV, will retry later"
            fi
        fi
        
        # Check internet periodically
        if ! check_internet; then
            echo "Internet check failed, WiFi monitor will handle reconnection"
        fi
        
        sleep $check_interval
    done
}

# Error handling
handle_error() {
    echo "Error occurred in ADS Display startup script!"
    echo "Error details: $1"
    echo "Check the log file for more details: $LOG_FILE"
    
    # Show current status
    show_system_status
    
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