#!/bin/bash

# ADS Display Dependencies Installation Script
# For Raspberry Pi and other Linux systems

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
    unclutter

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

# Install MPV media player
print_status "Installing MPV media player..."
sudo apt install -y mpv

# Verify MPV installation
mpv_version=$(mpv --version | head -n1)
print_status "MPV version: $mpv_version"

# Create necessary directories
print_status "Creating application directories..."
mkdir -p "/home/$USERNAME/Desktop/pi_server"
# mkdir -p "/home/$USERNAME/Desktop/pi_server/ads-videos"
mkdir -p "/home/$USERNAME/Desktop/pi_server/logs"
mkdir -p "/home/$USERNAME/Desktop/pi_server/config"

# Set up npm in the project directory (if package.json exists)
if [[ -f "/home/$USERNAME/Desktop/pi_server/package.json" ]]; then
    print_status "Installing Node.js project dependencies..."
    cd "/home/$USERNAME/Desktop/pi_server"
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

# Configure automatic startup
print_status "Setting up automatic startup..."

# Create systemd service file
sudo tee /etc/systemd/system/ads-display.service > /dev/null <<EOF
[Unit]
Description=ADS Display Application
After=network.target graphical.target
Wants=network.target

[Service]
Type=simple
User=$USERNAME
Group=$USERNAME
WorkingDirectory=/home/$USERNAME/Desktop/pi_server
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/$USERNAME/.Xauthority
ExecStart=/bin/bash /home/$USERNAME/Desktop/pi_server/start_ads_display.sh
Restart=always
RestartSec=10

[Install]
WantedBy=graphical.target
EOF

# Create desktop autostart entry
mkdir -p "/home/$USERNAME/.config/autostart"
tee "/home/$USERNAME/.config/autostart/ads-display.desktop" > /dev/null <<EOF
[Desktop Entry]
Type=Application
Name=ADS Display
Exec=/bin/bash /home/$USERNAME/Desktop/pi_server/start_ads_display.sh
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
EOF

# Make startup script executable
if [[ -f "/home/$USERNAME/Desktop/pi_server/start_ads_display.sh" ]]; then
    chmod +x "/home/$USERNAME/Desktop/pi_server/start_ads_display.sh"
fi

# Make this installation script executable
chmod +x "$0"

# Reload systemd
sudo systemctl daemon-reload

print_status "Installation completed successfully!"
echo ""
print_status "Next steps:"
echo "1. Configure ngrok: ngrok config add-authtoken <YOUR_TOKEN>"
echo "2. Place your video files in: /home/$USERNAME/Desktop/pi_server/ads-videos/"
echo "3. Configure WiFi via the admin dashboard after starting the application"
echo "4. Reboot the system to start automatically: sudo reboot"
echo ""
print_status "To start manually:"
echo "  bash /home/$USERNAME/Desktop/pi_server/start_ads_display.sh"
echo ""
print_status "To enable automatic startup:"
echo "  sudo systemctl enable ads-display.service"

echo "=========================================="
echo "Installation Complete!"
echo "=========================================="