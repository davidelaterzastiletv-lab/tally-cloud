const express = require('express');
const https = require('https');
const socketIo = require('socket.io');
const path = require('path');
const xml2js = require('xml2js');
const fs = require('fs-extra');

// Usa fetch globale (Node 18+) se disponibile, altrimenti usa node-fetch
const fetch = globalThis.fetch || require('node-fetch');

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'config.json');

// --- INIZIO SEZIONE SERVER (HTTPS LOCALE / HTTP CLOUD) ---
let server;
const certPath = path.join(__dirname, 'server.cert');
const keyPath = path.join(__dirname, 'server.key');

if (fs.existsSync(certPath) && fs.existsSync(keyPath) && !process.env.RENDER) {
    // Siamo in locale e abbiamo i certificati
    const options = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
    };
    const https = require('https');
    server = https.createServer(options, app);
    console.log('Avviato in modalità HTTPS (Locale)');
} else {
    // Siamo su Render o non abbiamo certificati
    const http = require('http');
    server = http.createServer(app);
    console.log('Avviato in modalità HTTP (Cloud/Standard)');
}
// --- FINE SEZIONE SERVER ---

const io = socketIo(server);

let vmixIp = 'localhost:8088';
let pollInterval = null;
let isBridgeActive = false; // Flag per capire se stiamo ricevendo dati dal cloud
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

// Load configuration on startup
async function loadConfig() {
    try {
        if (await fs.pathExists(CONFIG_FILE)) {
            const data = await fs.readJson(CONFIG_FILE);
            vmixIp = data.vmixIp || vmixIp;
            cameras = data.cameras || cameras;
            directorSettings = { ...directorSettings, ...(data.directorSettings || {}) };
            console.log('Configurazione caricata con successo');
        }
        // Start polling regardless if config was found (uses defaults if not)
        startPolling();
    } catch (err) {
        console.error('Errore nel caricamento della configurazione:', err);
        startPolling(); // Still start polling if error
    }
}

async function saveConfig() {
    try {
        await fs.writeJson(CONFIG_FILE, { vmixIp, cameras, directorSettings });
    } catch (err) {
        console.error('Errore nel salvataggio della configurazione:', err);
    }
}

loadConfig();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API to update vMix IP and configuration
app.post('/api/config', (req, res) => {
    const { ip, newCameras, settings } = req.body;
    if (ip) vmixIp = ip;
    if (newCameras) cameras = newCameras;
    if (settings) directorSettings = { ...directorSettings, ...settings };

    saveConfig();
    if (!isBridgeActive) startPolling(); // Solo se non siamo sotto comando Bridge
    // Broadcast the update to all connected clients immediately
    io.emit('configUpdate', { cameras, vmixIp, directorSettings });
    res.json({ status: 'ok', vmixIp, cameras, directorSettings });
});

app.get('/api/state', (req, res) => {
    res.json({ vmixIp, cameras });
});

// --- INIZIO MODALITÀ BRIDGE ---
// Endpoint per ricevere il tally da un server locale (Bridge)
app.post('/api/tally-push', (req, res) => {
    const { tallyStates, connected, remoteCameras } = req.body;
    
    // Se riceviamo dati dal cloud, disattiviamo il polling locale su Render
    isBridgeActive = true;

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
// --- FINE MODALITÀ BRIDGE ---

let isVmixConnected = false;

async function pollVmix() {
    if (isBridgeActive && !process.env.REMOTE_SERVER) return; // Se siamo su Render e il bridge è attivo, non facciamo nulla

    try {
        const response = await fetch(`http://${vmixIp}/api`);
        const xml = await response.text();
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(xml);

        if (!isVmixConnected) {
            isVmixConnected = true;
            io.emit('vmixStatus', { connected: true });
            
            // Invia subito lo stato online al cloud se siamo in bridge mode
            if (process.env.REMOTE_SERVER) {
                fetch(`${process.env.REMOTE_SERVER}/api/tally-push`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tallyStates: [], connected: true })
                }).catch(() => { });
            }
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

        // Se è definito un server remoto (modalità Bridge), invia il segnale al cloud
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
                if (res.ok) {
                    if (Date.now() % 5000 < 600) console.log('>>> Segnale inviato al Cloud: Ricevuto da Render (OK)');
                } else {
                    console.error(`!!! Render ha respinto il segnale (Errore ${res.status}). Assicurati di aver aggiornato il codice su Render!`);
                }
            }).catch((e) => console.error('!!! Errore di rete verso il Cloud:', e.message));
        }
    } catch (err) {
        if (isVmixConnected) {
            isVmixConnected = false;
            io.emit('vmixStatus', { connected: false });
            io.emit('error', 'Unable to connect to vMix');

            if (process.env.REMOTE_SERVER) {
                fetch(`${process.env.REMOTE_SERVER}/api/tally-push`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tallyStates: [], connected: false })
                }).catch(() => { });
            }
        }
        console.error('Errore vMix:', err.message);
    }
}

function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(pollVmix, 500);
}

io.on('connection', (socket) => {
    console.log('New client connected');
    socket.emit('configUpdate', { cameras, vmixIp, directorSettings });
    socket.emit('vmixStatus', { connected: isVmixConnected });

    // --- INIZIO WEBRTC SIGNALING ---
    socket.on('webrtc-offer', (data) => {
        socket.broadcast.emit('webrtc-offer', data);
    });

    socket.on('webrtc-answer', (data) => {
        socket.broadcast.emit('webrtc-answer', data);
    });

    socket.on('webrtc-ice', (data) => {
        socket.broadcast.emit('webrtc-ice', data);
    });

    socket.on('intercomToggle', (data) => {
        socket.broadcast.emit('intercomStatusUpdate', data);
    });
    // --- FINE WEBRTC SIGNALING ---

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

server.listen(PORT, () => {
    console.log(`Server running on https://localhost:${PORT}`);
});
