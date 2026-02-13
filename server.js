const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});



app.use(express.json());

// Login System
const DIRECTOR_PASSWORD = process.env.DIRECTOR_PASSWORD || 'Davide-admin';
const SESSION_TOKEN = 'valid-session-' + Date.now(); // Simple in-memory token

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === DIRECTOR_PASSWORD) {
        res.json({ token: SESSION_TOKEN });
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
});

// Serve frontend files
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    // Disabilita cache per essere sicuri che si veda la nuova home
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// State store
let currentTally = [];
// Inizializziamo con 4 Camere di Default per la modalità "Walkie Talkie Web"
let currentConfig = {
    cameras: [
        { id: '1', name: 'Camera 1', inputNumber: 1 },
        { id: '2', name: 'Camera 2', inputNumber: 2 },
        { id: '3', name: 'Camera 3', inputNumber: 3 },
        { id: '4', name: 'Camera 4', inputNumber: 4 }
    ],
    vmixIp: '127.0.0.1',
    directorSettings: {}
};
let bridgeSocket = null; // The connection to the local computer

io.on('connection', (socket) => {
    console.log(`New client connected: ${socket.id}`);

    // Identify who is connecting
    const clientType = socket.handshake.query.type;
    const token = socket.handshake.query.token;

    // Security Check
    if (clientType === 'bridge' && token) {
        if (token !== SESSION_TOKEN) {
            console.log('ACCESS DENIED: Invalid Token');
            return socket.disconnect(true);
        }
        console.log('WEB DIRECTOR AUTHENTICATED');
    }

    if (clientType === 'bridge') {
        // Se è un Web Bridge, inviamogli subito lo stato se lo abbiamo
        if (currentConfig) socket.emit('configUpdate', currentConfig);
        console.log('BRIDGE CONNECTED');
        bridgeSocket = socket;

        // Bridge sends initial state
        socket.on('tallyUpdate', (data) => {
            currentTally = data;
            socket.broadcast.emit('tallyUpdate', data); // Broadcast to all operators
        });

        // Bridge sends config params
        socket.on('configUpdate', (data) => {
            console.log('Configurazione ricevuta dal Bridge');
            currentConfig = data; // Salviamo la configurazione
            socket.broadcast.emit('configUpdate', data);
        });

        // WebRTC Signaling: Bridge (Director) -> Operator
        socket.on('webrtc-offer', (data) => socket.broadcast.emit('webrtc-offer', data));
        socket.on('webrtc-answer', (data) => socket.broadcast.emit('webrtc-answer', data));
        socket.on('webrtc-ice', (data) => socket.broadcast.emit('webrtc-ice', data));

        socket.on('disconnect', () => {
            console.log('BRIDGE DISCONNECTED');
            bridgeSocket = null;
        });

    } else {
        // It's an operator
        // Send current state immediately
        socket.emit('tallyUpdate', currentTally);

        // FIX: Se abbiamo già la configurazione in memoria, mandiamola subito al nuovo arrivato!
        if (currentConfig) {
            socket.emit('configUpdate', currentConfig);
        }

        // WebRTC Signaling: Operator -> Bridge (Director)
        socket.on('webrtc-offer', (data) => {
            if (bridgeSocket) bridgeSocket.emit('webrtc-offer', data);
        });
        socket.on('webrtc-answer', (data) => {
            if (bridgeSocket) bridgeSocket.emit('webrtc-answer', data);
        });
        socket.on('webrtc-ice', (data) => {
            if (bridgeSocket) bridgeSocket.emit('webrtc-ice', data);
        });
    }

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

server.listen(PORT, () => {
    console.log(`Cloud Server running on port ${PORT}`);
});
