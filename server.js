const express = require('express');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs'); // Usiamo fs standard invece di fs-extra per evitare errori di installazione

// Moduli caricati in modo "pigro" (lazy load) per non far crashare Render se l'installazione fallisce
let xml2js;
try { xml2js = require('xml2js'); } catch (e) { console.warn('Polling locale disabilitato (xml2js assente)'); }

// Usa fetch globale (Node 18+) se disponibile, altrimenti tenta di caricare node-fetch
let fetch;
try { fetch = globalThis.fetch || require('node-fetch'); } catch (e) { console.warn('Utilizzo fetch standard del sistema'); }

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'config.json');

// --- CONFIGURAZIONE AUTOMATICA CLOUD ---
// Se non siamo su Render, impostiamo l'URL del cloud come predefinito per l'invio dati
if (!process.env.RENDER && !process.env.REMOTE_SERVER) {
    process.env.REMOTE_SERVER = 'https://tally-cloud.onrender.com';
    console.log(`>>> Modalità Bridge Automatica: Invio dati a ${process.env.REMOTE_SERVER}`);
}

let server;
const app = express();
const certPath = path.join(__dirname, 'server.cert');
const keyPath = path.join(__dirname, 'server.key');

if (fs.existsSync(certPath) && fs.existsSync(keyPath) && !process.env.RENDER) {
    const https = require('https');
    server = https.createServer({
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
    }, app);
    console.log('Avviato in modalità HTTPS (Locale)');
} else {
    const http = require('http');
    server = http.createServer(app);
    console.log('Avviato in modalità HTTP (Cloud/Standard)');
}
const io = socketIo(server);

let vmixIp = 'localhost:8088';
let pollInterval = null;
let isBridgeActive = false;
let isVmixConnected = false;
let cameras = [
    { id: 1, name: 'Camera 1', inputNumber: 1 },
    { id: 2, name: 'Camera 2', inputNumber: 2 }
];
let directorSettings = { audioSource: '', videoReturnSource: '', audioReturnSource: '', videoBitrate: '1.0' };

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Pagina principale per l'EXE (Dashboard locale)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'bridge-ui.html'));
});

app.post('/api/tally-push', (req, res) => {
    const { tallyStates, connected, remoteCameras } = req.body;
    isBridgeActive = true;
    if (connected !== undefined && connected !== isVmixConnected) {
        isVmixConnected = connected;
        io.emit('vmixStatus', { connected });
    }
    if (remoteCameras) {
        cameras = remoteCameras;
        io.emit('configUpdate', { cameras, vmixIp, directorSettings });
    }
    if (Array.isArray(tallyStates)) {
        io.emit('tallyUpdate', tallyStates);
    }
    res.json({ status: 'ok' });
});

app.post('/api/config', (req, res) => {
    const { ip, newCameras, settings } = req.body;
    if (ip) vmixIp = ip;
    if (newCameras) cameras = newCameras;
    if (settings) directorSettings = { ...directorSettings, ...settings };
    saveConfig();
    if (!isBridgeActive) startPolling();
    io.emit('configUpdate', { cameras, vmixIp, directorSettings });
    res.json({ status: 'ok', vmixIp, cameras, directorSettings });
});

app.get('/api/state', (req, res) => {
    res.json({ vmixIp, cameras, isVmixConnected });
});

async function pollVmix() {
    if (isBridgeActive && !process.env.REMOTE_SERVER) return;
    if (!xml2js || !fetch) return;
    try {
        const response = await fetch(`http://${vmixIp}/api`);
        const xml = await response.text();
        const result = await (new xml2js.Parser()).parseStringPromise(xml);
        if (!isVmixConnected) {
            isVmixConnected = true;
            io.emit('vmixStatus', { connected: true });
        }
        const active = parseInt(result.vmix.active[0]);
        const preview = parseInt(result.vmix.preview[0]);
        const tallyStates = cameras.map(cam => ({
            id: cam.id,
            status: cam.inputNumber === active ? 'program' : (cam.inputNumber === preview ? 'preview' : 'off')
        }));
        io.emit('tallyUpdate', tallyStates);
        if (process.env.REMOTE_SERVER) {
            fetch(`${process.env.REMOTE_SERVER}/api/tally-push`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tallyStates, connected: true, remoteCameras: cameras })
            }).then(r => r.ok && Date.now() % 5000 < 600 && console.log('>>> Cloud Sync OK')).catch(() => {});
        }
    } catch (err) {
        if (isVmixConnected) {
            isVmixConnected = false;
            io.emit('vmixStatus', { connected: false });
        }
    }
}

function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(pollVmix, 500);
}

function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            vmixIp = data.vmixIp || vmixIp;
            cameras = data.cameras || cameras;
            directorSettings = { ...directorSettings, ...(data.directorSettings || {}) };
        } catch (e) {}
    }
    startPolling();
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ vmixIp, cameras, directorSettings }));
    } catch (e) {}
}

loadConfig();

io.on('connection', (socket) => {
    socket.emit('configUpdate', { cameras, vmixIp, directorSettings });
    socket.emit('vmixStatus', { connected: isVmixConnected });
    socket.on('webrtc-offer', d => socket.broadcast.emit('webrtc-offer', d));
    socket.on('webrtc-answer', d => socket.broadcast.emit('webrtc-answer', d));
    socket.on('webrtc-ice', d => socket.broadcast.emit('webrtc-ice', d));
    socket.on('intercomToggle', d => socket.broadcast.emit('intercomStatusUpdate', d));
});

server.listen(PORT, () => {
    const isHttps = fs.existsSync(certPath) && fs.existsSync(keyPath) && !process.env.RENDER;
    const protocol = isHttps ? 'https' : 'http';
    
    console.log(`=========================================`);
    console.log(`   TALLY CLOUD BRIDGE ATTIVO (${protocol.toUpperCase()})`);
    console.log(`   Indirizzo: ${protocol}://localhost:${PORT}`);
    console.log(`=========================================`);

    // Apre automaticamente la dashboard nel browser se siamo sul PC locale
    if (!process.env.RENDER) {
        const startCommand = (process.platform == 'darwin' ? 'open' : process.platform == 'win32' ? 'start' : 'xdg-open');
        setTimeout(() => {
            try { 
                require('child_process').exec(`${startCommand} ${protocol}://localhost:${PORT}`);
                console.log(">>> Dashboard aperta nel browser.");
            } catch (e) {
                console.error("Errore apertura browser:", e.message);
            }
        }, 1000);
    }
});
