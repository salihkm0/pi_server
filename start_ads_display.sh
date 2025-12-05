#!/bin/bash

# ADS Display Startup Script - Fast MPV Start
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
echo "ADS Display Startup Script (Fast MPV)"
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
            sleep 1
            if xset -q > /dev/null 2>&1; then
                return 0
            fi
        fi
        return 1
    fi
}

# Fast X server startup with timeout
start_xserver_fast() {
    if is_lite_version; then
        echo "Lite version detected - fast X server startup..."
        
        # Check if X server is already running
        if is_xserver_running; then
            echo "X server is already running"
            return 0
        fi
        
        # Kill any existing X servers
        pkill Xorg 2>/dev/null || true
        pkill X 2>/dev/null || true
        sleep 1
        
        echo "Starting X server in fast mode..."
        
        # Try multiple methods to start X server
        local xserver_methods=(
            "sudo X :0 -ac -nocursor -retro > /dev/null 2>&1"
            "startx -- -nocursor -retro > /dev/null 2>&1"
            "/usr/bin/X :0 -ac -nocursor -retro > /dev/null 2>&1"
            "xinit -- -nocursor -retro > /dev/null 2>&1"
        )
        
        for method in "${xserver_methods[@]}"; do
            echo "Trying: $method"
            eval "$method &"
            local xserver_pid=$!
            
            # Fast check (5 seconds max)
            local fast_check=0
            while [[ $fast_check -lt 5 ]]; do
                if is_xserver_running; then
                    echo "✅ X server started successfully (PID: $xserver_pid)"
                    
                    # Quick X configuration
                    xset s off 2>/dev/null || true
                    xset -dpms 2>/dev/null || true
                    xset s noblank 2>/dev/null || true
                    
                    return 0
                fi
                sleep 1
                ((fast_check++))
            done
            
            # Kill if not successful
            kill -9 $xserver_pid 2>/dev/null || true
        done
        
        echo "⚠️ Fast X server startup failed, trying alternative..."
        return 1
    fi
    return 0
}

# Alternative: Start X server in background and continue
start_xserver_background() {
    if is_lite_version; then
        echo "Starting X server in background (non-blocking)..."
        
        # Start X server without waiting
        sudo X :0 -ac -nocursor -retro > /dev/null 2>&1 &
        local xserver_pid=$!
        
        echo "X server started in background (PID: $xserver_pid)"
        
        # Quick configuration attempts
        for i in {1..3}; do
            sleep 1
            if xset -q > /dev/null 2>&1; then
                xset s off 2>/dev/null || true
                xset -dpms 2>/dev/null || true
                echo "✅ X server configured"
                return 0
            fi
        done
        
        echo "⚠️ X server starting in background..."
        return 1
    fi
    return 0
}

# Check if we have videos available
has_videos() {
    if [[ -f "$PLAYLIST" ]] && [[ -s "$PLAYLIST" ]] && [[ $(wc -l < "$PLAYLIST" 2>/dev/null) -gt 0 ]]; then
        return 0
    else
        # Check directory directly
        if [[ -d "$VIDEO_DIR" ]]; then
            local video_count=$(find "$VIDEO_DIR" -type f \( -name "*.mp4" -o -name "*.avi" -o -name "*.mkv" -o -name "*.mov" -o -name "*.MP4" -o -name "*.AVI" -o -name "*.MKV" -o -name "*.MOV" \) 2>/dev/null | wc -l)
            if [[ $video_count -gt 0 ]]; then
                return 0
            fi
        fi
        return 1
    fi
}

# Fast playlist creation
create_fast_playlist() {
    echo "Creating fast playlist..."
    
    if [[ -d "$VIDEO_DIR" ]]; then
        # Quick find for videos
        find "$VIDEO_DIR" -maxdepth 1 -type f \( -name "*.mp4" -o -name "*.avi" -o -name "*.mkv" -o -name "*.mov" -o -name "*.MP4" -o -name "*.AVI" -o -name "*.MKV" -o -name "*.MOV" \) 2>/dev/null | head -20 > "$PLAYLIST"
        
        local video_count=$(wc -l < "$PLAYLIST" 2>/dev/null || echo 0)
        if [[ $video_count -gt 0 ]]; then
            echo "✅ Found $video_count videos"
            return 0
        fi
    fi
    
    echo "⚠️ No videos found"
    return 1
}

# Start MPV immediately (5 second timeout)
start_mpv_fast() {
    echo "Starting MPV with 5-second timeout..."
    
    # Check if MPV is installed
    if ! command -v mpv &> /dev/null; then
        echo "❌ MPV not installed"
        return 1
    fi
    
    # Check for videos
    if ! has_videos; then
        echo "❌ No videos available"
        return 1
    fi
    
    # Create fast playlist
    create_fast_playlist
    
    # Kill any existing MPV
    pkill -f mpv 2>/dev/null || true
    sleep 1
    
    echo "Launching MPV..."
    
    # Start MPV with minimal options for speed
    mpv \
        --fs \
        --shuffle \
        --loop-playlist=inf \
        --playlist="$PLAYLIST" \
        --no-terminal \
        --really-quiet \
        --volume=80 \
        --hwdec=auto \
        --cache=yes \
        --cache-secs=10 \
        --input-ipc-server="$MPV_SOCKET" \
        > "$BASE_DIR/logs/mpv_fast.log" 2>&1 &
    
    local mpv_pid=$!
    
    echo "MPV started (PID: $mpv_pid)"
    
    # Quick check if MPV is running
    sleep 2
    if kill -0 $mpv_pid 2>/dev/null; then
        echo "✅ MPV playback started within 5 seconds"
        return 0
    else
        echo "❌ MPV failed to start"
        return 1
    fi
}

# Enhanced MPV startup with retry
start_mpv_with_retry() {
    echo "Starting MPV playback with retry..."
    
    local max_attempts=3
    local attempt=1
    
    while [[ $attempt -le $max_attempts ]]; do
        echo "MPV attempt $attempt/$max_attempts..."
        
        # Try fast MPV first
        if start_mpv_fast; then
            return 0
        fi
        
        # Wait before retry
        sleep 3
        ((attempt++))
    done
    
    echo "❌ Failed to start MPV after $max_attempts attempts"
    return 1
}

# Main startup sequence optimized for speed
main() {
    echo "🚀 Starting ADS Display System (Fast Mode)..."
    echo "Target: Start MPV within 5 seconds if videos available"
    
    # Start Node.js app in background (handles WiFi)
    echo "Starting Node.js app in background..."
    cd "$BASE_DIR" || { echo "❌ Failed to navigate to directory"; exit 1; }
    
    # Kill existing node processes
    pkill -f "node.*server.js" 2>/dev/null || true
    fuser -k 3006/tcp 2>/dev/null || true
    sleep 1
    
    # Start Node.js app
    node server.js > "$BASE_DIR/logs/node_app.log" 2>&1 &
    local node_pid=$!
    echo "✅ Node.js app started (PID: $node_pid)"
    
    # For Lite version, start X server FAST
    if is_lite_version; then
        echo "🖥️  Starting X server (fast mode)..."
        
        # Try fast startup first
        if ! start_xserver_fast; then
            echo "⚠️  Fast X server failed, starting in background..."
            start_xserver_background
        fi
    else
        echo "🖥️  Desktop version - X server should already be running"
    fi
    
    # Check if we have videos immediately
    echo "📹 Checking for videos..."
    if has_videos; then
        echo "✅ Videos available - starting MPV NOW..."
        
        # Start MPV immediately (within 5 seconds)
        start_mpv_with_retry
        
        if [[ $? -eq 0 ]]; then
            echo "🎬 MPV STARTED SUCCESSFULLY WITHIN 5 SECONDS!"
        else
            echo "⚠️  MPV failed to start quickly, will retry in background"
        fi
    else
        echo "⚠️  No videos found yet, MPV will start when videos are available"
    fi
    
    # Continue with normal startup in background
    {
        echo "Continuing with normal startup sequence..."
        
        # Wait for Node.js app to be ready
        local node_ready=false
        for i in {1..30}; do
            if curl -s http://localhost:3006/health > /dev/null 2>&1; then
                echo "✅ Node.js app ready"
                node_ready=true
                break
            fi
            sleep 1
        done
        
        if ! $node_ready; then
            echo "⚠️ Node.js app not responding, but continuing..."
        fi
        
        # Ensure X server is ready (longer wait)
        if is_lite_version; then
            echo "Waiting for X server to stabilize..."
            for i in {1..30}; do
                if is_xserver_running; then
                    echo "✅ X server stable"
                    break
                fi
                sleep 1
            done
        fi
        
        # Start directory monitoring
        echo "Starting directory monitoring..."
        {
            while true; do
                if has_videos && ! pgrep -f mpv > /dev/null 2>&1; then
                    echo "🎬 Videos available but MPV not running - starting..."
                    start_mpv_with_retry
                fi
                sleep 10
            done
        } &
        
        # Start periodic playlist refresh
        echo "Starting playlist refresh..."
        {
            while true; do
                sleep 60
                if has_videos; then
                    create_fast_playlist
                fi
            done
        } &
        
    } &
    
    # Show status
    echo ""
    echo "=========================================="
    echo "SYSTEM STATUS"
    echo "=========================================="
    echo "Node.js App: 🟡 STARTING (PID: $node_pid)"
    echo "MPV Player: $(pgrep -f mpv > /dev/null && echo '✅ RUNNING' || echo '🟡 STARTING/STOPPED')"
    echo "X Server: $(is_xserver_running && echo '✅ RUNNING' || echo '🟡 STARTING')"
    echo "Videos: $(has_videos && echo '✅ AVAILABLE' || echo '❌ NOT FOUND')"
    echo "=========================================="
    echo ""
    
    # Keep main script running
    echo "System startup initiated..."
    echo "MPV should start within 5 seconds if videos are available"
    echo "Press Ctrl+C to stop"
    echo ""
    
    # Monitor and restart if needed
    while true; do
        # Check MPV every 30 seconds
        if has_videos && ! pgrep -f mpv > /dev/null 2>&1; then
            echo "🔄 Restarting MPV (not running but videos available)..."
            start_mpv_with_retry
        fi
        
        sleep 30
    done
}

# Error handling
handle_error() {
    echo "❌ Error occurred at line $1"
    echo "🔄 Restarting in 5 seconds..."
    sleep 5
    main
}

# Set error trap
trap 'handle_error $LINENO' ERR
trap 'echo "Received SIGINT, stopping..."; pkill -f mpv; pkill -f node; exit 0' INT

# Run main function
main