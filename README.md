# Transmission Modern UI

A third-party, modern web interface for the [Transmission](https://transmissionbt.com/) BitTorrent client. It is responsive, dependency-free, and built with plain HTML, CSS, and JavaScript.

> [!WARNING]
> This project is still under development and has not been tested with every Transmission version or operating system. Test it before using it in production, and keep a backup of the original web interface.

## Features

- Responsive interface for desktop and mobile devices
- Light and dark themes
- Search, filter, and sort torrents
- Add torrents using files, URLs, magnet links, or info hashes
- Start, stop, verify, move, rename, and remove torrents
- View torrent files, peers, trackers, and transfer details
- Manage queues, file priorities, labels, speed limits, and preferences
- Drag-and-drop support
- Modern and legacy Transmission RPC support
- No framework, package manager, or build step required

## Requirements

- A running Transmission daemon with remote access enabled
- A modern web browser
- Git for the installation examples below

## Installation

### Option 1: Use `TRANSMISSION_WEB_HOME`

This is the recommended option because it does not replace Transmission's original files.

1. Clone the repository:

   ```bash
   git clone https://github.com/michael-sulyak/transmission-modern-ui.git
   cd transmission-modern-ui
   ```

2. Set `TRANSMISSION_WEB_HOME` to the repository directory:

   ```bash
   export TRANSMISSION_WEB_HOME="$(pwd)"
   ```

3. Start or restart Transmission from the same environment:

   ```bash
   transmission-daemon
   ```

4. Open the web interface. The common default address is:

   ```text
   http://localhost:9091/transmission/web/
   ```

`TRANSMISSION_WEB_HOME` must be available each time Transmission starts. If Transmission runs through systemd, Docker, or another service manager, add the variable to that service's environment and restart the service.

### Option 2: Replace `/usr/share/transmission/public_html`

Use this option only when your Transmission installation serves its web interface from `/usr/share/transmission/public_html`. Distribution paths may differ.

1. Clone the project into a temporary directory:

   ```bash
   git clone https://github.com/michael-sulyak/transmission-modern-ui.git
   cd transmission-modern-ui
   ```

2. Back up the original interface:

   ```bash
   sudo mv /usr/share/transmission/public_html \
     /usr/share/transmission/public_html.backup
   ```

3. Create the replacement directory and copy the UI files:

   ```bash
   sudo mkdir -p /usr/share/transmission/public_html
   sudo cp index.html main.css main.js /usr/share/transmission/public_html/
   ```

4. Restart Transmission:

   ```bash
   sudo systemctl restart transmission-daemon
   ```

5. Open Transmission in your browser and perform a hard refresh.

If `public_html.backup` already exists, rename it or choose a different backup name before running these commands. Some systems use `/usr/share/transmission/web` instead; verify the path used by your installation first.

#### Restore the original interface

```bash
sudo rm -rf /usr/share/transmission/public_html
sudo mv /usr/share/transmission/public_html.backup \
  /usr/share/transmission/public_html
sudo systemctl restart transmission-daemon
```

## Updating

Pull the latest source:

```bash
cd transmission-modern-ui
git pull
```

When using `TRANSMISSION_WEB_HOME`, refresh the browser after updating. When using the manual installation, copy `index.html`, `main.css`, and `main.js` to `/usr/share/transmission/public_html` again and restart Transmission.

## Configuration

The interface expects the Transmission RPC endpoint at the standard relative path `../rpc`. If you use a reverse proxy, keep the web interface and RPC endpoint under the usual Transmission URL structure.

Do not expose Transmission directly to the public internet without authentication and HTTPS.

## AI-generated code notice

Most of this project's code was generated with the assistance of AI/LLM tools.

## License

This project is licensed under the MIT License.
