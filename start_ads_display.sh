#!/bin/bash

# ADS Display Startup Script - Optimized for Raspberry Pi
# Video playback only - WiFi is managed by Node.js app

# Configuration
BASE_DIR="/home/$USER/pi_server"
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
echo "ADS Display Startup Script (RPi Optimized)"
echo "User: $USERNAME"
echo "Base Directory: $BASE_DIR"
echo "Started at: $(date)"
echo "=========================================="

# Set PATH for cron environment
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin

# Set DISPLAY for GUI applications like MPV
export DISPLAY=:0

# Check if we're on Raspberry Pi
is_raspberry_pi() {
    if [ -f /proc/device-tree/model ]; then
        if grep -q "Raspberry Pi" /proc/device-tree/model; then
            return 0
        fi
    fi
    return 1
}

# Get Raspberry Pi model
get_rpi_model() {
    if [ -f /proc/device-tree/model ]; then
        cat /proc/device-tree/model | tr -d '\0'
    else
        echo "Unknown"
    fi
}

# Function to check if X server is running
is_xserver_running() {
    if xset -q > /dev/null 2>&1; then
        return 0
    else
        if pgrep Xorg > /dev/null 2>&1; then
            sleep 1
            if xset -q > /dev/null 2>&1; then
                return 0
            fi
        fi
        return 1
    fi
}

# Start X server for Raspberry Pi Lite
start_xserver_rpi() {
    echo "Starting X server for Raspberry Pi..."
    
    # Check if X server is already running
    if is_xserver_running; then
        echo "X server is already running"
        return 0
    fi
    
    # Kill any existing X servers
    pkill Xorg 2>/dev/null || true
    pkill X 2>/dev/null || true
    sleep 1
    
    echo "Starting X server with RPi optimized settings..."
    
    # Start X server with RPi specific settings
    startx -- -nocursor -retro -depth 24 -dpi 96 > /dev/null 2>&1 &
    local xserver_pid=$!
    
    echo "X server started with PID: $xserver_pid"
    
    # Wait for X server (max 10 seconds)
    for i in {1..10}; do
        if is_xserver_running; then
            echo "✅ X server ready (attempt $i)"
            
            # Configure X for better performance
            xset s off 2>/dev/null || true
            xset -dpms 2>/dev/null || true
            xset s noblank 2>/dev/null || true
            
            return 0
        fi
        sleep 1
    done
    
    echo "⚠️ X server not ready, but continuing..."
    return 1
}

# Check if we have videos available
has_videos() {
    if [[ -f "$PLAYLIST" ]] && [[ -s "$PLAYLIST" ]] && [[ $(wc -l < "$PLAYLIST" 2>/dev/null) -gt 0 ]]; then
        return 0
    else
        if [[ -d "$VIDEO_DIR" ]]; then
            local video_count=$(find "$VIDEO_DIR" -maxdepth 1 -type f \( -name "*.mp4" -o -name "*.MP4" \) 2>/dev/null | wc -l)
            if [[ $video_count -gt 0 ]]; then
                return 0
            fi
        fi
        return 1
    fi
}

# Create optimized playlist for RPi
create_playlist_rpi() {
    echo "Creating playlist for Raspberry Pi..."
    
    if [[ -d "$VIDEO_DIR" ]]; then
        # For RPi, prefer MP4 files (better hardware acceleration)
        find "$VIDEO_DIR" -maxdepth 1 -type f \( -name "*.mp4" -o -name "*.MP4" \) 2>/dev/null | sort > "$PLAYLIST"
        
        # If no MP4 files, include other formats
        if [[ ! -s "$PLAYLIST" ]]; then
            find "$VIDEO_DIR" -maxdepth 1 -type f \( -name "*.avi" -o -name "*.mkv" -o -name "*.mov" \) 2>/dev/null | sort > "$PLAYLIST"
        fi
        
        local video_count=$(wc -l < "$PLAYLIST" 2>/dev/null || echo 0)
        if [[ $video_count -gt 0 ]]; then
            echo "✅ Found $video_count videos"
            return 0
        fi
    fi
    
    echo "⚠️ No videos found"
    return 1
}

# Get optimal MPV settings for Raspberry Pi model
get_mpv_settings_rpi() {
    local model=$(get_rpi_model)
    echo "Raspberry Pi Model: $model"
    
    # Default settings for RPi 4
    local settings=""
    
    # Hardware acceleration settings
    settings+="--hwdec=rpi-mmal "
    settings+="--vd-lavc-dr=yes "
    settings+="--vd-lavc-threads=4 "
    
    # Video output
    settings+="--vo=gpu "
    settings+="--gpu-context=drm "
    settings+="--drm-mode=preferred "
    
    # Performance settings
    settings+="--cache=yes "
    settings+="--cache-secs=30 "
    settings+="--demuxer-max-bytes=500M "
    settings+="--demuxer-readahead-secs=30 "
    settings+="--vd-lavc-fast "
    settings+="--no-hidpi-window-scale "
    
    # RPi 3 or older - different settings
    if [[ "$model" == *"Pi 3"* ]] || [[ "$model" == *"Pi 2"* ]] || [[ "$model" == *"Pi 1"* ]] || [[ "$model" == *"Pi Zero"* ]]; then
        echo "⚠️ Older RPi detected, using conservative settings"
        settings=""
        settings+="--hwdec=mmal "
        settings+="--vo=gpu "
        settings+="--gpu-context=mmal "
        settings+="--cache=yes "
        settings+="--cache-secs=60 "
        settings+="--demuxer-max-bytes=200M "
        settings+="--demuxer-readahead-secs=60 "
        settings+="--vd-lavc-skiploopfilter=nonkey "
        settings+="--vd-lavc-fast "
        settings+="--scale=bilinear "
        settings+="--cscale=bilinear "
        settings+="--dscale=bilinear "
        settings+="--tscale=bilinear "
    fi
    
    # RPi 4 or newer - optimized settings
    if [[ "$model" == *"Pi 4"* ]] || [[ "$model" == *"Pi 5"* ]] || [[ "$model" == *"Pi 400"* ]]; then
        echo "✅ Modern RPi detected, using optimized settings"
        settings=""
        settings+="--hwdec=rpi "
        settings+="--vo=gpu "
        settings+="--gpu-context=drm "
        settings+="--drm-mode=preferred "
        settings+="--drm-connector=HDMI-A-1 "
        settings+="--cache=yes "
        settings+="--cache-secs=20 "
        settings+="--demuxer-max-bytes=1G "
        settings+="--demuxer-readahead-secs=20 "
        settings+="--interpolation "
        settings+="--tscale=oversample "
        settings+="--video-sync=display-resample "
        settings+="--video-latency-hacks=yes "
        settings+="--profile=high-quality "
    fi
    
    echo "$settings"
}

# Start MPV with Raspberry Pi optimized settings
start_mpv_rpi() {
    echo "Starting MPV with Raspberry Pi optimizations..."
    
    # Check if MPV is installed
    if ! command -v mpv &> /dev/null; then
        echo "❌ MPV not installed"
        echo "Install: sudo apt update && sudo apt install mpv"
        return 1
    fi
    
    # Check for videos
    if ! has_videos; then
        echo "❌ No videos available"
        return 1
    fi
    
    # Create playlist
    create_playlist_rpi
    
    # Kill any existing MPV
    pkill -f mpv 2>/dev/null || true
    sleep 2
    
    # Get RPi specific settings
    local rpi_settings=$(get_mpv_settings_rpi)
    
    echo "Launching MPV with optimized settings..."
    
    # Create logs directory
    mkdir -p "$BASE_DIR/logs"
    
    # Start MPV with RPi optimized settings
    mpv \
        --fs \
        --no-border \
        --ontop \
        --shuffle \
        --loop-playlist=inf \
        --playlist="$PLAYLIST" \
        --no-terminal \
        --really-quiet \
        --volume=80 \
        --no-osc \
        --osd-level=0 \
        --no-osd-bar \
        --input-ipc-server="$MPV_SOCKET" \
        --keep-open=yes \
        --no-resume-playback \
        $rpi_settings \
        > "$BASE_DIR/logs/mpv_rpi.log" 2>&1 &
    
    local mpv_pid=$!
    
    echo "MPV started with PID: $mpv_pid"
    echo "Using settings: $rpi_settings"
    
    # Check if MPV is running
    sleep 3
    if kill -0 $mpv_pid 2>/dev/null; then
        echo "✅ MPV playback started successfully"
        
        # Send initial commands to MPV
        sleep 2
        if [[ -S "$MPV_SOCKET" ]]; then
            echo '{ "command": ["set_property", "volume", 80] }' | socat - "$MPV_SOCKET" 2>/dev/null || true
            echo '{ "command": ["set_property", "shuffle", true] }' | socat - "$MPV_SOCKET" 2>/dev/null || true
        fi
        
        return 0
    else
        echo "❌ MPV failed to start, checking logs..."
        tail -20 "$BASE_DIR/logs/mpv_rpi.log"
        
        # Try fallback settings
        echo "🔄 Trying fallback settings..."
        start_mpv_fallback
        return $?
    fi
}

# Fallback MPV settings (minimal)
start_mpv_fallback() {
    echo "Starting MPV with fallback settings..."
    
    pkill -f mpv 2>/dev/null || true
    sleep 2
    
    # Minimal settings for compatibility
    mpv \
        --fs \
        --playlist="$PLAYLIST" \
        --loop-playlist=inf \
        --no-terminal \
        --really-quiet \
        --volume=80 \
        --hwdec=auto \
        --vo=xv \
        --cache=yes \
        --cache-secs=60 \
        > "$BASE_DIR/logs/mpv_fallback.log" 2>&1 &
    
    local mpv_pid=$!
    
    sleep 2
    if kill -0 $mpv_pid 2>/dev/null; then
        echo "✅ MPV started with fallback settings"
        return 0
    else
        echo "❌ MPV failed even with fallback settings"
        return 1
    fi
}

# Check and install required packages
check_dependencies() {
    echo "Checking dependencies..."
    
    # Check MPV
    if ! command -v mpv &> /dev/null; then
        echo "⚠️ MPV not found, attempting to install..."
        sudo apt update && sudo apt install -y mpv
    fi
    
    # Check socat for MPV IPC
    if ! command -v socat &> /dev/null; then
        echo "⚠️ socat not found, installing..."
        sudo apt install -y socat
    fi
    
    # Check for Raspberry Pi firmware
    if is_raspberry_pi; then
        echo "Checking Raspberry Pi firmware..."
        
        # Update firmware for better video support
        echo "Updating RPi firmware (if needed)..."
        sudo apt update
        sudo apt install -y raspberrypi-kernel raspberrypi-kernel-headers
        
        # Enable DRM/KMS for RPi 4+
        local model=$(get_rpi_model)
        if [[ "$model" == *"Pi 4"* ]] || [[ "$model" == *"Pi 5"* ]]; then
            echo "Enabling DRM/KMS for RPi 4/5..."
            sudo raspi-config nonint do_memory_split 256
        fi
    fi
    
    echo "✅ Dependencies checked"
}

# Optimize system for video playback
optimize_system() {
    echo "Optimizing system for video playback..."
    
    # Increase USB/Filesystem buffers
    echo "vm.swappiness=10" | sudo tee -a /etc/sysctl.conf > /dev/null
    echo "vm.dirty_ratio=10" | sudo tee -a /etc/sysctl.conf > /dev/null
    echo "vm.dirty_background_ratio=5" | sudo tee -a /etc/sysctl.conf > /dev/null
    
    # Apply settings
    sudo sysctl -p > /dev/null 2>&1 || true
    
    # Set CPU governor to performance
    if [ -f /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor ]; then
        echo "performance" | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor > /dev/null 2>&1 || true
    fi
    
    # Disable screen blanking
    if command -v xset &> /dev/null; then
        xset s off 2>/dev/null || true
        xset -dpms 2>/dev/null || true
        xset s noblank 2>/dev/null || true
    fi
    
    echo "✅ System optimized"
}

# Main startup sequence
main() {
    echo "🚀 Starting ADS Display System (RPi Optimized)..."
    
    # Check if we're on Raspberry Pi
    if is_raspberry_pi; then
        echo "✅ Running on Raspberry Pi: $(get_rpi_model)"
        
        # Check and install dependencies
        check_dependencies
        
        # Optimize system
        optimize_system
    else
        echo "⚠️ Not running on Raspberry Pi, using generic settings"
    fi
    
    # Start Node.js app in background
    echo "Starting Node.js app..."
    cd "$BASE_DIR" || { echo "❌ Failed to navigate to directory"; exit 1; }
    
    # Kill existing processes
    pkill -f "node.*server.js" 2>/dev/null || true
    fuser -k 3006/tcp 2>/dev/null || true
    sleep 1
    
    # Start Node.js
    node server.js > "$BASE_DIR/logs/node_app.log" 2>&1 &
    local node_pid=$!
    echo "✅ Node.js app started (PID: $node_pid)"
    
    # Start X server (for Lite version)
    if ! is_xserver_running; then
        echo "Starting X server..."
        start_xserver_rpi
    else
        echo "✅ X server already running"
    fi
    
    # Give X server a moment
    sleep 2
    
    # Start MPV if videos available
    if has_videos; then
        echo "✅ Videos available - starting MPV..."
        
        # Start MPV with RPi optimizations
        if start_mpv_rpi; then
            echo "🎬 MPV started successfully!"
        else
            echo "⚠️ MPV failed to start, will retry"
        fi
    else
        echo "⚠️ No videos found yet"
        
        # Check for videos every 10 seconds
        {
            while true; do
                sleep 10
                if has_videos && ! pgrep -f mpv > /dev/null 2>&1; then
                    echo "🎬 Videos now available - starting MPV..."
                    start_mpv_rpi
                fi
            done
        } &
    fi
    
    # Monitor and maintain system
    echo "Starting system monitor..."
    {
        while true; do
            # Check MPV every 30 seconds
            if has_videos && ! pgrep -f mpv > /dev/null 2>&1; then
                echo "🔄 Restarting MPV..."
                start_mpv_rpi
            fi
            
            # Check Node.js every minute
            if ! pgrep -f "node.*server.js" > /dev/null 2>&1; then
                echo "🔄 Restarting Node.js..."
                cd "$BASE_DIR"
                node server.js > "$BASE_DIR/logs/node_app.log" 2>&1 &
            fi
            
            sleep 30
        done
    } &
    
    # Show status
    echo ""
    echo "=========================================="
    echo "SYSTEM STATUS"
    echo "=========================================="
    echo "Device: $(get_rpi_model)"
    echo "Node.js: $(pgrep -f "node.*server.js" > /dev/null && echo '✅ RUNNING' || echo '❌ STOPPED')"
    echo "MPV: $(pgrep -f mpv > /dev/null && echo '✅ RUNNING' || echo '❌ STOPPED')"
    echo "X Server: $(is_xserver_running && echo '✅ RUNNING' || echo '❌ STOPPED')"
    echo "Videos: $(has_videos && echo '✅ AVAILABLE' || echo '❌ NOT FOUND')"
    echo "=========================================="
    echo ""
    
    echo "System started successfully!"
    echo "Press Ctrl+C to stop"
    echo ""
    
    # Keep script alive
    wait
}

# Error handling
handle_error() {
    echo "❌ Error occurred at line $1"
    echo "🔄 Restarting in 10 seconds..."
    sleep 10
    main
}

# Cleanup on exit
cleanup() {
    echo "Cleaning up..."
    pkill -f mpv 2>/dev/null || true
    pkill -f "node.*server.js" 2>/dev/null || true
    exit 0
}

# Set traps
trap 'handle_error $LINENO' ERR
trap 'cleanup' INT TERM EXIT

# Run main function
main