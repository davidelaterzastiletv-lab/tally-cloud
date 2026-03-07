const { app, BrowserWindow, session } = require('electron');
const path = require('path');

// Forza il superamento dei blocchi di sicurezza per il microfono in locale
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

process.env.ELECTRON_RUNNING = 'true';
require('./server.js');

function createWindow() {
    const win = new BrowserWindow({
        width: 1100,
        height: 800,
        title: "Tally Cloud Bridge - Dashboard",
        backgroundColor: '#0f172a',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // Gestione permessi audio/video
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
        if (permission === 'media') return true;
        return true;
    });
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'media') return callback(true);
        callback(true);
    });

    setTimeout(() => {
        // Carichiamo sempre la versione HTTP in locale per evitare conflitti SSL se possibile,
        // o HTTPS se i file esistono.
        const protocol = (require('fs').existsSync(path.join(__dirname, 'server.cert'))) ? 'https' : 'http';
        win.loadURL(`${protocol}://localhost:3000`).catch(() => {
            setTimeout(() => win.loadURL(`${protocol}://localhost:3000`), 1000);
        });
    }, 1500);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
