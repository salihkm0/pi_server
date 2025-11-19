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
    xorg

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
    npm install
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
    
    chmod +x "/home/$USERNAME/.xinitrc"
    
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

# Make startup script executable
if [[ -f "$BASE_DIR/start_ads_display.sh" ]]; then
    chmod +x "$BASE_DIR/start_ads_display.sh"
fi

# Make this installation script executable
chmod +x "$0"

# Reload systemd
sudo systemctl daemon-reload

# Enable the service
sudo systemctl enable ads-display.service

print_status "Installation completed successfully!"
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
echo "  bash $BASE_DIR/start_ads_display.sh"
echo ""
print_status "Automatic startup is enabled via systemd service"

echo "=========================================="
echo "Installation Complete!"
echo "=========================================="