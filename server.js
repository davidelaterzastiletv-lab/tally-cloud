const express = require('express');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs-extra');

// Moduli caricati in modo "pigro" (lazy load) per non far crashare Render se l'installazione fallisce
let xml2js;
try {
    xml2js = require('xml2js');
} catch (e) {
    console.warn('Polling locale disabilitato (xml2js assente)');
}

// Usa fetch globale (Node 18+) se disponibile, altrimenti tenta di caricare node-fetch
let fetch;
try {
    fetch = globalThis.fetch || require('node-fetch');
} catch (e) {
    console.warn('Utilizzo fetch standard del sistema');
}

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'config.json');

// --- SERVER HTTP/HTTPS INTELLIGENTE ---
// Render fornisce già HTTPS tramite il suo proxy, quindi in cloud usiamo HTTP standard.
// In locale usiamo HTTPS per permettere l'uso del microfono nei browser.
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

// --- STATO APPLICAZIONE ---
let vmixIp = 'localhost:8088';
let pollInterval = null;
let isBridgeActive = false;
let isVmixConnected = false;
let cameras = [
    { id: 1, name: 'Camera 1', inputNumber: 1 },
    { id: 2, name: 'Camera 2', inputNumber: 2 },
    { id: 3, name: 'Camera 3', inputNumber: 3 },
    { id: 4, name: 'Camera 4', inputNumber: 4 }
];
let directorSettings = {
    audioSource: '',
    videoReturnSource: '',
    audioReturnSource: '',
    videoBitrate: '1.0'
};

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- ENDPOINT PER MODALITÀ BRIDGE (CLOUD) ---
// Riceve i dati dal tuo PC locale e li distribuisce agli operatori su Internet
app.post('/api/tally-push', (req, res) => {
    const { tallyStates, connected, remoteCameras } = req.body;
    isBridgeActive = true; // Segnala che stiamo ricevendo dati dal cloud

    if (connected !== undefined && connected !== isVmixConnected) {
        isVmixConnected = connected;
        io.emit('vmixStatus', { connected: isVmixConnected });
    }

    // Sincronizza le camere se inviate dal locale
    if (remoteCameras && JSON.stringify(remoteCameras) !== JSON.stringify(cameras)) {
        cameras = remoteCameras;
        io.emit('configUpdate', { cameras, vmixIp, directorSettings });
    }

    if (Array.isArray(tallyStates)) {
        io.emit('tallyUpdate', tallyStates);
    }
    res.json({ status: 'ok' });
});

// Endpoint configurazione
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

// --- FUNZIONI DI POLLING ---
async function pollVmix() {
    // Se siamo su Render e stiamo ricevendo dal Bridge, non controlliamo vMix locale
    if (isBridgeActive && !process.env.REMOTE_SERVER) return;
    if (!xml2js || !fetch) return;

    try {
        const response = await fetch(`http://${vmixIp}/api`);
        const xml = await response.text();
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(xml);

        if (!isVmixConnected) {
            isVmixConnected = true;
            io.emit('vmixStatus', { connected: true });
        }

        const activeInput = parseInt(result.vmix.active[0]);
        const previewInput = parseInt(result.vmix.preview[0]);

        const tallyStates = cameras.map(cam => {
            let status = 'off';
            if (cam.inputNumber === activeInput) status = 'program';
            else if (cam.inputNumber === previewInput) status = 'preview';
            return { id: cam.id, status };
        });

        io.emit('tallyUpdate', tallyStates);

        // Se siamo in modalità Bridge e abbiamo un server remoto, inviamo i dati
        if (process.env.REMOTE_SERVER) {
            fetch(`${process.env.REMOTE_SERVER}/api/tally-push`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    tallyStates, 
                    connected: isVmixConnected,
                    remoteCameras: cameras 
                })
            }).then(res => {
                if (res.ok && Date.now() % 5000 < 600) console.log('>>> Cloud Sync OK');
            }).catch(() => {});
        }
    } catch (err) {
        if (isVmixConnected) {
            isVmixConnected = false;
            io.emit('vmixStatus', { connected: false });
        }
        if (!isBridgeActive) console.error('Errore vMix:', err.message);
    }
}

function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(pollVmix, 500);
}

// Caricamento configurazione
async function loadConfig() {
    try {
        if (await fs.pathExists(CONFIG_FILE)) {
            const data = await fs.readJson(CONFIG_FILE);
            vmixIp = data.vmixIp || vmixIp;
            cameras = data.cameras || cameras;
            directorSettings = { ...directorSettings, ...(data.directorSettings || {}) };
        }
        startPolling();
    } catch (err) {
        startPolling();
    }
}

async function saveConfig() {
    try {
        await fs.writeJson(CONFIG_FILE, { vmixIp, cameras, directorSettings });
    } catch (err) {}
}

loadConfig();

// --- GESTIONE SOCKET.IO ---
io.on('connection', (socket) => {
    socket.emit('configUpdate', { cameras, vmixIp, directorSettings });
    socket.emit('vmixStatus', { connected: isVmixConnected });

    socket.on('webrtc-offer', data => socket.broadcast.emit('webrtc-offer', data));
    socket.on('webrtc-answer', data => socket.broadcast.emit('webrtc-answer', data));
    socket.on('webrtc-ice', data => socket.broadcast.emit('webrtc-ice', data));
    socket.on('intercomToggle', data => socket.broadcast.emit('intercomStatusUpdate', data));
    socket.on('disconnect', () => {});
});

server.listen(PORT, () => {
    console.log(`Server attivo su porta ${PORT}`);
});
