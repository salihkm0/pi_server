#!/bin/bash

# ADS Display Startup Script
# Dynamic WiFi configuration and video playback

# Configuration
VIDEO_DIR="/home/$USER/Desktop/pi_server/ads-videos"
PLAYLIST="$VIDEO_DIR/playlist.txt"
MPV_SOCKET="/tmp/mpv-socket"
LOG_FILE="/home/$USER/Desktop/pi_server/logs/ads_display.log"
CONFIG_FILE="/home/$USER/Desktop/pi_server/config/device-config.json"

# Get current username
USERNAME=$(whoami)

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$(dirname "$CONFIG_FILE")"

# Redirect all output to log file
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=========================================="
echo "ADS Display Startup Script"
echo "User: $USERNAME"
echo "Started at: $(date)"
echo "=========================================="

# Set PATH for cron environment
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin

# Set DISPLAY for GUI applications like MPV
export DISPLAY=:0

# Function to display a black screen
show_black_screen() {
  echo "Displaying a black screen..."
  xsetroot -solid black
  unclutter -idle 0.1 -root & # Hides mouse pointer if necessary
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
  cd "/home/$USER/Desktop/pi_server/" || { echo "Failed to navigate to Node.js app directory"; return 1; }
  
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
    find "$VIDEO_DIR" -name "*.mp4" > "$PLAYLIST"
    local video_count=$(wc -l < "$PLAYLIST" 2>/dev/null || echo 0)
    echo "Playlist updated: $video_count videos found."
  else
    echo "Video directory not found: $VIDEO_DIR"
    mkdir -p "$VIDEO_DIR"
    echo "Created video directory: $VIDEO_DIR"
  fi
}

# Start MPV with IPC
start_mpv() {
  echo "Starting MPV playback with IPC..."
  
  # Check if MPV is installed
  if ! command -v mpv &> /dev/null; then
    echo "Error: MPV is not installed. Please run the installation script first."
    return 1
  fi
  
  # Kill any existing MPV processes
  pkill -f mpv || true
  sleep 2
  
  # Ensure playlist exists
  update_playlist
  
  # Check if there are videos to play
  if [[ ! -f "$PLAYLIST" ]] || [[ ! -s "$PLAYLIST" ]]; then
    echo "No videos found in playlist. MPV will start but play nothing."
    # Create empty playlist file
    touch "$PLAYLIST"
  fi
  
  # Start MPV
  mpv --fs --shuffle --loop-playlist=inf --osd-level=0 --no-terminal \
    --input-ipc-server="$MPV_SOCKET" --playlist="$PLAYLIST" \
    --keep-open=yes --no-resume-playback >/dev/null 2>&1 &
  local mpv_pid=$!
  
  echo "MPV started with IPC socket: $MPV_SOCKET (PID: $mpv_pid)"
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
    if [[ "$file" == *.mp4 ]]; then
      echo "MP4 file change detected: $file"
      sleep 5 # Small delay to allow for multiple changes
      update_playlist
      reload_mpv_playlist
    fi
  done &
}

# Main startup sequence
main() {
  echo "Starting ADS Display System..."
  
  # Wait for network to stabilize
  echo "Waiting for network initialization..."
  show_black_screen
  sleep 10
  
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
  
  # Start MPV playback
  start_mpv
  
  # Monitor directory for changes
  monitor_directory
  
  echo "=========================================="
  echo "ADS Display System Started Successfully"
  echo "User: $USERNAME"
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