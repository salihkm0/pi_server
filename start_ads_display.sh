#!/bin/bash

# ADS Display Startup Script
# Video playback without WiFi and black screen options
# Compatible with both Raspberry Pi Desktop and Lite versions

# Configuration - Dynamic paths based on Desktop availability
# Get the correct username (handle sudo/root execution)
if [ "$EUID" -eq 0 ]; then
    # If running as root/sudo, try to get the original username
    if [ -f "/home/spotus17/original_username.txt" ]; then
        USERNAME=$(cat /home/spotus17/original_username.txt)
    elif [ -f "/home/spotus17/device_id.json" ]; then
        # Fallback to spotus17 if we can't determine
        USERNAME="spotus17"
    else
        # Try to get from sudo environment
        USERNAME=${SUDO_USER:-$(logname 2>/dev/null || echo "spotus17")}
    fi
else
    USERNAME=$(whoami)
fi

# Save original username for future reference
echo "$USERNAME" > "/home/spotus17/original_username.txt" 2>/dev/null || true

echo "Running as user: $USERNAME"

# Determine base directory
if [ -d "/home/$USERNAME/Desktop" ]; then
    # Desktop version
    BASE_DIR="/home/$USERNAME/pi_server"
else
    # Lite version
    BASE_DIR="/home/$USERNAME/pi_server"
fi

VIDEO_DIR="$BASE_DIR/ads-videos"
PLAYLIST="$VIDEO_DIR/playlist.txt"
MPV_SOCKET="/tmp/mpv-socket"
LOG_FILE="$BASE_DIR/logs/ads_display.log"
NODE_APP_DIR="$BASE_DIR"  # Node.js app is in pi_server directory
NODE_LOG="$BASE_DIR/logs/node_app.log"

# Ensure directories exist
mkdir -p "$BASE_DIR/logs" 2>/dev/null || sudo mkdir -p "$BASE_DIR/logs"
mkdir -p "$VIDEO_DIR" 2>/dev/null || sudo mkdir -p "$VIDEO_DIR"

# Set proper permissions
if [ "$EUID" -eq 0 ]; then
    sudo chown -R $USERNAME:$USERNAME "$BASE_DIR" 2>/dev/null || true
    sudo chmod -R 755 "$BASE_DIR" 2>/dev/null || true
fi

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

# Function to start Node.js application with sudo
start_node_app() {
    echo "Starting Node.js application..."
    
    # Check if Node.js is installed
    if ! command -v node &> /dev/null; then
        echo "Warning: Node.js is not installed"
        echo "Install Node.js with: curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs"
        return 1
    fi
    
    # Check if npm is installed
    if ! command -v npm &> /dev/null; then
        echo "Warning: npm is not installed"
        echo "npm usually comes with Node.js installation"
        return 1
    fi
    
    # Check if package.json exists
    if [ ! -f "$NODE_APP_DIR/package.json" ]; then
        echo "Warning: package.json not found in $NODE_APP_DIR"
        echo "Looking for package.json..."
        ls -la "$NODE_APP_DIR/" | grep -i package
        return 1
    fi
    
    # Kill any existing Node.js processes from this app
    pkill -f "node.*$NODE_APP_DIR" || true
    sleep 1
    
    echo "Checking package.json for available scripts..."
    
    # Change to app directory first
    cd "$NODE_APP_DIR"
    
    # Check if running in development mode
    if grep -q '"dev"' "package.json"; then
        echo "Starting Node.js app in development mode (npm run dev)..."
        
        # Check if node_modules exists, if not install dependencies
        if [ ! -d "node_modules" ]; then
            echo "Installing Node.js dependencies..."
            npm install 2>&1 | tee -a "$NODE_LOG"
        fi
        
        # Start Node.js app
        echo "Starting: npm run dev"
        npm run dev > "$NODE_LOG" 2>&1 &
        local node_pid=$!
        
    elif grep -q '"start"' "package.json"; then
        echo "Starting Node.js app in production mode (npm start)..."
        
        if [ ! -d "node_modules" ]; then
            echo "Installing Node.js dependencies..."
            npm install --production 2>&1 | tee -a "$NODE_LOG"
        fi
        
        echo "Starting: npm start"
        npm start > "$NODE_LOG" 2>&1 &
        local node_pid=$!
        
    else
        echo "Warning: No start or dev script found in package.json"
        echo "Attempting to start with: node server.js or node app.js"
        
        # Try common entry points
        if [ -f "server.js" ]; then
            node server.js > "$NODE_LOG" 2>&1 &
            local node_pid=$!
            echo "Node.js application started with PID: $node_pid (server.js)"
        elif [ -f "app.js" ]; then
            node app.js > "$NODE_LOG" 2>&1 &
            local node_pid=$!
            echo "Node.js application started with PID: $node_pid (app.js)"
        elif [ -f "index.js" ]; then
            node index.js > "$NODE_LOG" 2>&1 &
            local node_pid=$!
            echo "Node.js application started with PID: $node_pid (index.js)"
        else
            echo "Error: No recognizable Node.js entry point found"
            echo "Looking for: server.js, app.js, index.js, or scripts in package.json"
            return 1
        fi
    fi
    
    # Wait a moment for Node.js to start
    sleep 3
    
    # Check if Node.js process is running
    if ps -p $node_pid > /dev/null 2>&1; then
        echo "Node.js application started successfully (PID: $node_pid)"
        return 0
    else
        echo "Warning: Node.js process may have failed to start"
        echo "Check the Node.js log: $NODE_LOG"
        return 1
    fi
}

# Function to update the playlist with proper permissions
update_playlist() {
    echo "Updating playlist..."
    
    # Ensure video directory exists
    if [ ! -d "$VIDEO_DIR" ]; then
        echo "Creating video directory: $VIDEO_DIR"
        mkdir -p "$VIDEO_DIR"
        if [ "$EUID" -eq 0 ]; then
            chown $USERNAME:$USERNAME "$VIDEO_DIR"
        fi
    fi
    
    # Create temporary playlist
    TEMP_PLAYLIST="/tmp/playlist_$$.txt"
    
    if [[ -d "$VIDEO_DIR" ]] && [[ -r "$VIDEO_DIR" ]]; then
        # Find all video files and create playlist
        echo "Searching for video files in: $VIDEO_DIR"
        find "$VIDEO_DIR" -type f \( -name "*.mp4" -o -name "*.avi" -o -name "*.mkv" -o -name "*.mov" -o -name "*.webm" \) 2>/dev/null | sort > "$TEMP_PLAYLIST"

        local video_count=$(wc -l < "$TEMP_PLAYLIST" 2>/dev/null || echo 0)
        echo "Found $video_count videos in $VIDEO_DIR"

        if [[ $video_count -gt 0 ]]; then
            echo "Videos found:"
            cat "$TEMP_PLAYLIST"
            
            # Copy to final playlist with proper permissions
            if [ "$EUID" -eq 0 ]; then
                sudo cp "$TEMP_PLAYLIST" "$PLAYLIST"
                sudo chown $USERNAME:$USERNAME "$PLAYLIST"
                sudo chmod 644 "$PLAYLIST"
            else
                cp "$TEMP_PLAYLIST" "$PLAYLIST"
                chmod 644 "$PLAYLIST"
            fi
        else
            echo "Warning: No video files found in $VIDEO_DIR"
            echo "Supported formats: mp4, avi, mkv, mov, webm"
            echo "# Empty playlist - waiting for videos" > "$TEMP_PLAYLIST"
            
            if [ "$EUID" -eq 0 ]; then
                sudo cp "$TEMP_PLAYLIST" "$PLAYLIST"
                sudo chown $USERNAME:$USERNAME "$PLAYLIST"
                sudo chmod 644 "$PLAYLIST"
            else
                cp "$TEMP_PLAYLIST" "$PLAYLIST"
                chmod 644 "$PLAYLIST"
            fi
        fi
    else
        echo "Video directory not accessible: $VIDEO_DIR"
        echo "# Empty playlist - waiting for videos" > "$TEMP_PLAYLIST"
        
        if [ "$EUID" -eq 0 ]; then
            sudo cp "$TEMP_PLAYLIST" "$PLAYLIST"
            sudo chown $USERNAME:$USERNAME "$PLAYLIST"
            sudo chmod 644 "$PLAYLIST"
        else
            cp "$TEMP_PLAYLIST" "$PLAYLIST"
            chmod 644 "$PLAYLIST"
        fi
    fi
    
    # Clean up temp file
    rm -f "$TEMP_PLAYLIST"
    
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
    
    # Change to video directory to avoid path issues
    cd "$VIDEO_DIR"
    
    # Start MPV with proper user
    if [ "$EUID" -eq 0 ]; then
        # If running as root, use sudo -u to run as the correct user
        sudo -u $USERNAME mpv --fs \
            --shuffle \
            --loop-playlist=inf \
            --no-terminal \
            --osd-level=0 \
            --input-ipc-server="$MPV_SOCKET" \
            --playlist="$PLAYLIST" \
            --keep-open=yes \
            --no-resume-playback \
            --hwdec=auto \
            --vo=xv \
            --no-keepaspect \
            --quiet > "$BASE_DIR/logs/mpv.log" 2>&1 &
    else
        # Run as current user
        mpv --fs \
            --shuffle \
            --loop-playlist=inf \
            --no-terminal \
            --osd-level=0 \
            --input-ipc-server="$MPV_SOCKET" \
            --playlist="$PLAYLIST" \
            --keep-open=yes \
            --no-resume-playback \
            --hwdec=auto \
            --vo=xv \
            --no-keepaspect \
            --quiet > "$BASE_DIR/logs/mpv.log" 2>&1 &
    fi
    
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
    
    # Ensure we have permission to monitor
    if [ ! -r "$VIDEO_DIR" ]; then
        echo "Warning: Cannot read video directory: $VIDEO_DIR"
        return 1
    fi
    
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

        inotifywait -r -e create -e modify -e moved_to -e delete --exclude '.*\.tmp$' --format '%w%f' "$VIDEO_DIR" 2>/dev/null | while read -r file; do
            echo "File change detected: $file"

            # Check if it's a video file or the playlist itself
            if [[ "$file" =~ \.(mp4|avi|mkv|mov|webm|txt)$ ]]; then
                echo "Video or playlist file changed: $(basename "$file")"

                # Wait for file operations to complete
                sleep 2

                # Update playlist
                update_playlist

                # Reload MPV playlist if MPV is running
                if pgrep mpv > /dev/null; then
                    force_reload_playlist
                fi

                echo "Playlist updated after file change"
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
        if [[ -d "$VIDEO_DIR" ]] && [[ -r "$VIDEO_DIR" ]]; then
            local current_count=$(find "$VIDEO_DIR" -type f \( -name "*.mp4" -o -name "*.avi" -o -name "*.mkv" -o -name "*.mov" -o -name "*.webm" \) 2>/dev/null | wc -l)
            local playlist_count=$(wc -l < "$PLAYLIST" 2>/dev/null || echo 0)

            if [[ $current_count -ne $playlist_count ]]; then
                echo "Playlist count mismatch (files: $current_count, playlist: $playlist_count). Updating..."
                update_playlist
                if pgrep mpv > /dev/null; then
                    force_reload_playlist
                fi
            fi
        fi
    done &
}

# Function to monitor and restart Node.js app if needed
monitor_node_app() {
    echo "Starting Node.js application monitor..."
    
    while true; do
        sleep 30
        
        # Check if Node.js app is running
        local node_running=false
        if pgrep -f "node.*$NODE_APP_DIR" > /dev/null; then
            node_running=true
        fi
        
        if [ "$node_running" = false ]; then
            echo "Node.js application not running. Restarting..."
            start_node_app
        fi
    done &
}

# Function to check if MPV is really playing
check_mpv_playing() {
    if [ -S "$MPV_SOCKET" ] && command -v socat > /dev/null 2>&1; then
        # Check if MPV is responding
        echo '{ "command": ["get_property", "pause"] }' | socat - "$MPV_SOCKET" 2>/dev/null | grep -q '"data":false'
        return $?
    fi
    return 1
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
    
    # Start Node.js application first (it may provide web interface or API)
    echo "Starting Node.js application..."
    start_node_app
    
    # Initial playlist creation
    echo "Setting up video playback..."
    update_playlist
    
    # Start MPV playback (only if X server is available)
    if is_xserver_running; then
        start_mpv
    else
        echo "X server not available - video playback disabled"
        echo "Check X server configuration and restart"
    fi
    
    # Monitor directory for changes (run in background)
    monitor_directory &
    
    # Start periodic playlist refresh (run in background)
    start_periodic_playlist_refresh &
    
    # Start Node.js application monitor (run in background)
    monitor_node_app &
    
    echo "=========================================="
    echo "ADS Display System Started Successfully"
    echo "User: $USERNAME"
    echo "Base Directory: $BASE_DIR"
    echo "Time: $(date)"
    echo "Node.js Application: $(pgrep -f "node.*$NODE_APP_DIR" > /dev/null && echo "RUNNING" || echo "NOT RUNNING")"
    echo "MPV Playback: $(pgrep mpv > /dev/null && echo "RUNNING" || echo "NOT RUNNING")"
    echo "Video directory: $VIDEO_DIR"
    echo "Videos found: $(find "$VIDEO_DIR" -type f \( -name "*.mp4" -o -name "*.avi" -o -name "*.mkv" -o -name "*.mov" -o -name "*.webm" \) 2>/dev/null | wc -l)"
    echo "=========================================="
    echo "Node.js log: $NODE_LOG"
    echo "System log: $LOG_FILE"
    echo "=========================================="
    
    # Main monitoring loop
    while true; do
        # Check if MPV should be running
        if is_xserver_running; then
            # Check if MPV is running
            if ! pgrep mpv > /dev/null 2>&1; then
                echo "MPV not running but X server is available. Restarting MPV..."
                start_mpv
            elif ! check_mpv_playing; then
                # MPV is running but might be stuck
                echo "MPV might be stuck. Checking status..."
                sleep 5
                if ! check_mpv_playing; then
                    echo "MPV appears stuck. Restarting..."
                    start_mpv
                fi
            fi
        fi
        
        # Reduce monitoring frequency to save CPU
        sleep 60
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