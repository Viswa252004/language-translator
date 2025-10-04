const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, '../frontend')));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Generate a unique ID for the file
    const uniqueId = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `${uniqueId}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// Store active rooms and transfers
const rooms = {};
const activeTransfers = {};

// Routes
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  const fileId = req.file.filename;
  const fileInfo = {
    id: fileId,
    name: req.file.originalname,
    size: req.file.size,
    type: req.file.mimetype,
    path: req.file.path
  };

  res.json({ success: true, fileInfo });
});

// Socket.IO for real-time file transfer
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Handle joining a room
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    console.log(`Client ${socket.id} joined room: ${roomId}`);

    // Initialize room if it doesn't exist
    if (!rooms[roomId]) {
      rooms[roomId] = {
        sender: null,
        receiver: null,
        fileId: null
      };
    }

    // Determine role based on who's already in the room
    if (!rooms[roomId].sender) {
      rooms[roomId].sender = socket.id;
      socket.emit('room-joined', { role: 'sender', roomId });
    } else if (!rooms[roomId].receiver) {
      rooms[roomId].receiver = socket.id;
      socket.emit('room-joined', { role: 'receiver', roomId });

      // Notify sender that receiver has joined
      io.to(rooms[roomId].sender).emit('user-joined', socket.id);
    } else {
      // Room is full
      socket.emit('room-full');
      socket.leave(roomId);
    }
  });

  // Handle sender starting a transfer
  socket.on('start-transfer', (data) => {
    const { fileId, receiverId } = data;
    const filePath = path.join(uploadsDir, fileId);

    if (!fs.existsSync(filePath)) {
      socket.emit('transfer-error', { message: 'File not found on server' });
      return;
    }

    const stats = fs.statSync(filePath);
    const fileInfo = {
      id: fileId,
      name: path.basename(filePath).split('-').slice(1).join('-'),
      size: stats.size,
      type: getMimeType(filePath)
    };

    // Store transfer info
    activeTransfers[socket.id] = {
      fileId,
      receiverId,
      filePath,
      sentBytes: 0,
      totalBytes: stats.size
    };

    // Notify receiver
    io.to(receiverId).emit('transfer-started', fileInfo);

    // Start sending file in chunks
    const readStream = fs.createReadStream(filePath);
    const chunkSize = 64 * 1024; // 64KB chunks

    readStream.on('data', (chunk) => {
      // Send chunk to receiver
      io.to(receiverId).emit('file-chunk', {
        fileId,
        chunk: chunk.toString('base64'),
        progress: Math.min(100, Math.round((activeTransfers[socket.id].sentBytes / stats.size) * 100))
      });

      activeTransfers[socket.id].sentBytes += chunk.length;

      // Update sender progress
      socket.emit('transfer-progress', {
        progress: Math.min(100, Math.round((activeTransfers[socket.id].sentBytes / stats.size) * 100))
      });
    });

    readStream.on('end', () => {
      // Notify both parties that transfer is complete
      socket.emit('transfer-complete');
      io.to(receiverId).emit('transfer-complete');

      // Clean up after a delay
      setTimeout(() => {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (err) {
          console.error('Error cleaning up file:', err);
        }
      }, 60000); // Delete file after 1 minute
    });

    readStream.on('error', (err) => {
      console.error('Error reading file:', err);
      socket.emit('transfer-error', { message: 'Error reading file' });
      io.to(receiverId).emit('transfer-error', { message: 'Error transferring file' });
      delete activeTransfers[socket.id];
    });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);

    // Clean up any active transfers
    if (activeTransfers[socket.id]) {
      // Notify receiver that transfer was cancelled
      io.to(activeTransfers[socket.id].receiverId).emit('transfer-cancelled');
      delete activeTransfers[socket.id];
    }

    // Clean up rooms
    for (const roomId in rooms) {
      if (rooms[roomId].sender === socket.id || rooms[roomId].receiver === socket.id) {
        delete rooms[roomId];
        break;
      }
    }
  });
});

// Helper function to determine MIME type
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.woff': 'application/font-woff',
    '.ttf': 'application/font-ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.otf': 'application/font-otf',
    '.wasm': 'application/wasm'
  };

  return mimeTypes[ext] || 'application/octet-stream';
}
 const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

