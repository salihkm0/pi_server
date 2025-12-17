#!/bin/bash

# ADS Display Dependencies Installation Script
# For Raspberry Pi Desktop and Lite versions

set -e

echo "=========================================="
echo "ADS Display Dependencies Installation"
echo "=========================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   print_error "This script should not be run as root"
   exit 1
fi

# Get current username
USERNAME=$(whoami)
print_status "Installing dependencies for user: $USERNAME"

# Detect if this is Lite version (no Desktop folder)
if [ -d "/home/$USERNAME/Desktop" ]; then
    BASE_DIR="/home/$USERNAME/Desktop/pi_server"
    print_status "Desktop version detected. Using base directory: $BASE_DIR"
else
    BASE_DIR="/home/$USERNAME/pi_server"
    print_status "Lite version detected. Using base directory: $BASE_DIR"
fi

# Update package list
print_status "Updating package list..."
sudo apt update

# Install system dependencies
print_status "Installing system dependencies..."
sudo apt install -y \
    curl \
    wget \
    git \
    build-essential \
    python3 \
    python3-pip \
    net-tools \
    wireless-tools \
    network-manager \
    inotify-tools \
    socat \
    unclutter \
    x11-utils \
    xserver-xorg \
    xinit \
    xorg \
    cron

# For Lite version, install minimal X server and window manager
if [ ! -d "/home/$USERNAME/Desktop" ]; then
    print_status "Installing X server and minimal desktop environment for Lite version..."
    sudo apt install -y \
        xserver-xorg \
        xinit \
        xorg \
        openbox \
        lightdm \
        feh
fi

# Install Node.js (using NodeSource repository)
print_status "Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verify Node.js installation
node_version=$(node --version)
npm_version=$(npm --version)
print_status "Node.js version: $node_version"
print_status "NPM version: $npm_version"

# Install PM2 for process management
print_status "Installing PM2..."
sudo npm install -g pm2

# Install ngrok
print_status "Installing ngrok..."
curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update
sudo apt install -y ngrok

# Configure ngrok (you'll need to add your authtoken later)
print_status "Ngrok installed. Remember to configure with: ngrok config add-authtoken <YOUR_AUTH_TOKEN>"

# Install MPV media player with hardware acceleration
print_status "Installing MPV media player with hardware acceleration..."
sudo apt install -y mpv

# Configure MPV for better performance on Raspberry Pi
print_status "Configuring MPV for Raspberry Pi optimization..."
mkdir -p "/home/$USERNAME/.config/mpv"

cat > "/home/$USERNAME/.config/mpv/mpv.conf" << 'EOF'
# Raspberry Pi optimized configuration
hwdec=mmal
vo=gpu
gpu-context=wayland,x11
profile=gpu-hq

# Performance optimizations
cache=yes
cache-secs=300
demuxer-max-bytes=500M
demuxer-max-back-bytes=100M

# Input optimizations
input-builtin-bindings=yes
input-default-bindings=yes
input-vo-keyboard=no

# Skip frames to catch up after lag
framedrop=vo

# Network optimizations
ytdl=no
EOF

# Verify MPV installation
mpv_version=$(mpv --version | head -n1)
print_status "MPV version: $mpv_version"

# Create necessary directories
print_status "Creating application directories..."
mkdir -p "$BASE_DIR"
mkdir -p "$BASE_DIR/ads-videos"
mkdir -p "$BASE_DIR/logs"
mkdir -p "$BASE_DIR/config"

# Set up npm in the project directory (if package.json exists)
if [[ -f "$BASE_DIR/package.json" ]]; then
    print_status "Installing Node.js project dependencies..."
    cd "$BASE_DIR"
    sudo npm install
else
    print_warning "package.json not found. Node.js dependencies will be installed when you set up the project."
fi

# Configure NetworkManager for WiFi management
print_status "Configuring NetworkManager..."
sudo systemctl enable NetworkManager
sudo systemctl start NetworkManager

# Add user to necessary groups
print_status "Setting up user permissions..."
sudo usermod -a -G audio "$USERNAME"
sudo usermod -a -G video "$USERNAME"
sudo usermod -a -G netdev "$USERNAME"
sudo usermod -a -G input "$USERNAME"

# For Lite version: Configure automatic X server start
if [ ! -d "/home/$USERNAME/Desktop" ]; then
    print_status "Configuring automatic X server startup for Lite version..."
    
    # Create .xinitrc for autostart
    cat > "/home/$USERNAME/.xinitrc" << 'EOF'
#!/bin/bash
# Start ADS Display application
exec bash /home/'"$USERNAME"'/pi_server/start_ads_display.sh
EOF
    
    sudo chmod +x "/home/$USERNAME/.xinitrc"
    
    # Enable automatic login to X server
    sudo systemctl enable lightdm
fi

# Configure automatic startup
print_status "Setting up automatic startup..."

# Create systemd service file
sudo tee /etc/systemd/system/ads-display.service > /dev/null <<EOF
[Unit]
Description=ADS Display Application
After=network.target
Wants=network.target

[Service]
Type=simple
User=$USERNAME
Group=$USERNAME
WorkingDirectory=$BASE_DIR
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/$USERNAME/.Xauthority
ExecStart=/bin/bash $BASE_DIR/start_ads_display.sh
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# For Desktop version, create desktop autostart entry
if [ -d "/home/$USERNAME/Desktop" ]; then
    print_status "Creating desktop autostart entry for Desktop version..."
    mkdir -p "/home/$USERNAME/.config/autostart"
    tee "/home/$USERNAME/.config/autostart/ads-display.desktop" > /dev/null <<EOF
[Desktop Entry]
Type=Application
Name=ADS Display
Exec=/bin/bash $BASE_DIR/start_ads_display.sh
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
EOF
fi

# Make startup script executable WITH sudo
if [[ -f "$BASE_DIR/start_ads_display.sh" ]]; then
    print_status "Making start_ads_display.sh executable..."
    sudo chmod +x "$BASE_DIR/start_ads_display.sh"
    print_status "✅ start_ads_display.sh is now executable"
fi

# Setup crontab for automatic startup and monitoring
print_status "Setting up crontab entries..."

# Step 1: Clear existing crontab completely
print_status "Clearing existing crontab..."
echo "" | crontab -

# Step 2: Add new crontab entries
print_status "Adding new crontab entries..."
cat << EOF | crontab -
# ADS Display Crontab Configuration
# Auto-start after reboot
@reboot sleep 30 && export DISPLAY=:0 && export XAUTHORITY=/home/$USERNAME/.Xauthority && bash $BASE_DIR/start_ads_display.sh > $BASE_DIR/logs/cron_startup.log 2>&1

# Daily restart at 3 AM
0 3 * * * pkill -f start_ads_display.sh && sleep 10 && export DISPLAY=:0 && export XAUTHORITY=/home/$USERNAME/.Xauthority && bash $BASE_DIR/start_ads_display.sh > $BASE_DIR/logs/cron_restart.log 2>&1

# Recovery if process dies (every 5 minutes)
*/5 * * * * pgrep -f start_ads_display.sh > /dev/null || (export DISPLAY=:0 && export XAUTHORITY=/home/$USERNAME/.Xauthority && bash $BASE_DIR/start_ads_display.sh > $BASE_DIR/logs/cron_recovery.log 2>&1)

# Node.js health check (every 10 minutes)
*/10 * * * * curl -s http://localhost:3000/health > /dev/null || (pkill -f node && sleep 5 && cd $BASE_DIR && sudo node server.js >> $BASE_DIR/logs/node_recovery.log 2>&1 &)
EOF

# Verify crontab setup
print_status "Verifying crontab setup..."
echo "Current crontab entries:"
crontab -l

# Create a health check script for crontab
HEALTH_SCRIPT="$BASE_DIR/health_check.sh"

cat > "$HEALTH_SCRIPT" << 'EOF'
#!/bin/bash

# ADS Display Health Check Script
# This script is called by crontab to monitor and restart services if needed

BASE_DIR=''"$BASE_DIR"''
USERNAME=''"$USERNAME"''
LOG_FILE="$BASE_DIR/logs/health_check.log"

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Log function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Set display for GUI applications
export DISPLAY=:0
export XAUTHORITY=/home/$USERNAME/.Xauthority

log "Starting health check..."

# Check if Node.js app is running
if ! curl -s http://localhost:3000/health > /dev/null; then
    log "Node.js app is not responding. Restarting..."
    sudo pkill -f "node.*server.js" || true
    sleep 2
    cd "$BASE_DIR"
    sudo node server.js >> "$BASE_DIR/logs/node_restart.log" 2>&1 &
    log "Node.js app restarted"
fi

# Check if MPV is running
if ! pgrep -f mpv > /dev/null; then
    log "MPV is not running. Restarting..."
    sudo pkill -f mpv || true
    sleep 2
    
    # Start MPV if there are videos
    if [ -f "$BASE_DIR/ads-videos/playlist.txt" ] && [ -s "$BASE_DIR/ads-videos/playlist.txt" ]; then
        sudo -u $USERNAME mpv --fs --shuffle --loop-playlist=inf --osd-level=0 --no-terminal \
            --input-ipc-server=/tmp/mpv-socket \
            --playlist="$BASE_DIR/ads-videos/playlist.txt" \
            --keep-open=yes --no-resume-playback \
            --hwdec=auto --vo=xv \
            >> "$BASE_DIR/logs/mpv_restart.log" 2>&1 &
        log "MPV restarted"
    else
        log "No videos found for MPV to play"
    fi
fi

# Check disk space (warning if below 20%)
DISK_USAGE=$(df / | awk 'NR==2 {print $5}' | sed 's/%//')
if [ "$DISK_USAGE" -gt 80 ]; then
    log "Warning: Disk usage is at ${DISK_USAGE}%"
fi

log "Health check completed"
EOF

sudo chmod +x "$HEALTH_SCRIPT"

# Step 3: Add health check to crontab (every 10 minutes)
print_status "Adding health check to crontab..."
(
    crontab -l 2>/dev/null | grep -v "health_check.sh"
    echo "*/10 * * * * bash $HEALTH_SCRIPT"
) | crontab -

# Final verification
print_status "Final crontab verification..."
echo "All crontab entries:"
crontab -l
echo ""

# Make this installation script executable with sudo
sudo chmod +x "$0"

# Reload systemd
sudo systemctl daemon-reload

# Enable the service
sudo systemctl enable ads-display.service

# Start cron service
sudo systemctl enable cron
sudo systemctl start cron

print_status "Installation completed successfully!"
echo ""
print_status "Crontab has been cleared and reconfigured with:"
echo "  - @reboot: Auto-start after 30 seconds"
echo "  - Daily 3 AM: Restart application" 
echo "  - Every 5 minutes: Recovery if process dies"
echo "  - Every 10 minutes: Node.js health check"
echo "  - Every 10 minutes: Comprehensive health check"
echo ""
print_status "Next steps:"
echo "1. Configure ngrok: ngrok config add-authtoken <YOUR_TOKEN>"
echo "2. Place your video files in: $BASE_DIR/ads-videos/"
echo "3. Configure WiFi via the admin dashboard after starting the application"
if [ ! -d "/home/$USERNAME/Desktop" ]; then
    echo "4. For Lite version: X server will start automatically on boot"
fi
echo "5. Reboot the system to start automatically: sudo reboot"
echo ""
print_status "To start manually:"
echo "  sudo bash $BASE_DIR/start_ads_display.sh"
echo ""
print_status "View crontab: crontab -l"
print_status "View logs: tail -f $BASE_DIR/logs/health_check.log"
print_status "Automatic startup is enabled via systemd service AND crontab"

echo "=========================================="
echo "Installation Complete!"
echo "=========================================="