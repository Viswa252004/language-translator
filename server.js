 const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app); // Create an HTTP server
const io = socketIo(server, { // Attach Socket.IO to the server
  cors: {
    origin: "*", // For development. In production, specify your frontend's URL.
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Use express.json() instead of bodyParser.json()
app.use(express.urlencoded({ extended: true })); // To handle form data

// --- API Routes ---

// Example test route
app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

// Serve static files from the 'public' directory (if needed)
// app.use(express.static(path.join(__dirname, '../frontend')));


// --- File Upload Logic ---

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
    const uniqueId = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `${uniqueId}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// Store active rooms and transfers
const rooms = {};
const activeTransfers = {};

// Route for uploading a file
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


// --- Socket.IO Logic for Real-time Transfer ---

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    console.log(`Client ${socket.id} joined room: ${roomId}`);

    if (!rooms[roomId]) {
      rooms[roomId] = { sender: null, receiver: null, fileId: null };
    }

    if (!rooms[roomId].sender) {
      rooms[roomId].sender = socket.id;
      socket.emit('room-joined', { role: 'sender', roomId });
    } else if (!rooms[roomId].receiver) {
      rooms[roomId].receiver = socket.id;
      socket.emit('room-joined', { role: 'receiver', roomId });
      io.to(rooms[roomId].sender).emit('user-joined', socket.id);
    } else {
      socket.emit('room-full');
      socket.leave(roomId);
    }
  });

  socket.on('start-transfer', (data) => {
    const { fileId, receiverId } = data;
    const filePath = path.join(uploadsDir, fileId);

    if (!fs.existsSync(filePath)) {
      socket.emit('transfer-error', { message: 'File not found on server' });
      return;
    }

    const stats = fs.statSync(filePath);
    activeTransfers[socket.id] = {
      fileId, receiverId, filePath, sentBytes: 0, totalBytes: stats.size
    };

    const fileInfo = {
      id: fileId,
      name: path.basename(filePath).split('-').slice(1).join('-'),
      size: stats.size,
      type: getMimeType(filePath)
    };

    io.to(receiverId).emit('transfer-started', fileInfo);

    const readStream = fs.createReadStream(filePath);
    const chunkSize = 64 * 1024; // 64KB chunks

    readStream.on('data', (chunk) => {
      io.to(receiverId).emit('file-chunk', {
        fileId,
        chunk: chunk.toString('base64'),
        progress: Math.min(100, Math.round((activeTransfers[socket.id].sentBytes / stats.size) * 100))
      });
      activeTransfers[socket.id].sentBytes += chunk.length;
      socket.emit('transfer-progress', {
        progress: Math.min(100, Math.round((activeTransfers[socket.id].sentBytes / stats.size) * 100))
      });
    });

    readStream.on('end', () => {
      socket.emit('transfer-complete');
      io.to(receiverId).emit('transfer-complete');
      setTimeout(() => {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (err) { console.error('Error cleaning up file:', err); }
      }, 60000); // Delete file after 1 minute
    });

    readStream.on('error', (err) => {
      console.error('Error reading file:', err);
      socket.emit('transfer-error', { message: 'Error reading file' });
      io.to(receiverId).emit('transfer-error', { message: 'Error transferring file' });
      delete activeTransfers[socket.id];
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    if (activeTransfers[socket.id]) {
      io.to(activeTransfers[socket.id].receiverId).emit('transfer-cancelled');
      delete activeTransfers[socket.id];
    }
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
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.wav': 'audio/wav',
    '.mp4': 'video/mp4', '.woff': 'application/font-woff', '.ttf': 'application/font-ttf',
    '.eot': 'application/vnd.ms-fontobject', '.otf': 'application/font-otf', '.wasm': 'application/wasm'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
