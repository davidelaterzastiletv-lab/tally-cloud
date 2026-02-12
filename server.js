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

// Serve frontend files
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    // Disabilita cache per essere sicuri che si veda la nuova home
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// State store
let currentTally = [];
let currentConfig = null; // Memorizza la configurazione (nomi camere)
let bridgeSocket = null; // The connection to the local computer

io.on('connection', (socket) => {
    console.log(`New client connected: ${socket.id}`);

    // Identify who is connecting
    const clientType = socket.handshake.query.type; // 'bridge' or 'operator'

    if (clientType === 'bridge') {
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
