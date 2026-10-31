// A two-screen Electron app for the Speedpatrol example config. The window
// loads index.html; `--remote-debugging-port` (set by the config) lets
// Speedpatrol drive it over CDP.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1024, height: 700 });
  window.loadFile(path.join(__dirname, 'index.html'));
});

app.on('window-all-closed', () => app.quit());
