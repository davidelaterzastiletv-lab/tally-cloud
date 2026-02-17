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
const SESSION_TOKEN = 'valid-session-' + Date.now();

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === DIRECTOR_PASSWORD) {
        res.json({ token: SESSION_TOKEN });
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// State store
let currentTally = [];
let currentConfig = {
    cameras: [
        { id: 1, name: 'Camera 1', inputNumber: 1 },
        { id: 2, name: 'Camera 2', inputNumber: 2 },
        { id: 3, name: 'Camera 3', inputNumber: 3 },
        { id: 4, name: 'Camera 4', inputNumber: 4 }
    ],
    vmixIp: '127.0.0.1',
    directorSettings: {}
};

io.on('connection', (socket) => {
    const clientType = socket.handshake.query.type;
    const token = socket.handshake.query.token;

    if (clientType === 'bridge') {
        // Security Check per il Web Director (opzionale per il bridge locale se non ha token)
        if (token && token !== SESSION_TOKEN) {
            console.log('ACCESS DENIED: Invalid Token');
            return socket.disconnect(true);
        }

        socket.join('bridges');
        console.log(`BRIDGE/DIRECTOR CONNECTED: ${socket.id}`);

        // Invia stato attuale
        socket.emit('configUpdate', currentConfig);
        if (currentTally.length > 0) socket.emit('tallyUpdate', currentTally);

        socket.on('tallyUpdate', (data) => {
            currentTally = data;
            io.to('operators').emit('tallyUpdate', data);
            io.to('bridges').emit('tallyUpdate', data);
        });

        socket.on('configUpdate', (data) => {
            console.log('Configurazione aggiornata');
            currentConfig = data;
            io.emit('configUpdate', data); // A tutti
        });

        socket.on('vmixStatus', (data) => {
            io.emit('vmixStatus', data);
        });

        // Signaling: Bridge -> Operator
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
            io.to('operators').emit('intercomStatusUpdate', data);
        });

    } else {
        // OPERATORE
        socket.join('operators');
        console.log(`OPERATOR CONNECTED: ${socket.id}`);

        socket.emit('tallyUpdate', currentTally);
        socket.emit('configUpdate', currentConfig);

        // Signaling: Operator -> Bridges
        socket.on('webrtc-offer', (data) => {
            io.to('bridges').emit('webrtc-offer', data);
        });
        socket.on('webrtc-answer', (data) => {
            io.to('bridges').emit('webrtc-answer', data);
        });
        socket.on('webrtc-ice', (data) => {
            io.to('bridges').emit('webrtc-ice', data);
        });

        socket.on('intercomToggle', (data) => {
            io.to('bridges').emit('intercomStatusUpdate', data);
        });
    }

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

server.listen(PORT, () => {
    console.log(`Cloud Server running on port ${PORT}`);
});
