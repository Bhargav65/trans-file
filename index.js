const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const { GridFSBucket, ObjectId } = require('mongodb');
const qrcode = require('qrcode');
require('dotenv').config();

const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const LINK_EXPIRY_MINUTES = 20;

app.use(express.static(__dirname));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const mongoUri = process.env.uri
mongoose.connect(mongoUri);

const conn = mongoose.connection;
let gfs;

conn.once('open', async () => {
  console.log('MongoDB connected');

  gfs = new GridFSBucket(conn.db, { bucketName: 'uploads' });

  // Ensure critical index for fast streaming
  await conn.db.collection('uploads.chunks').createIndex({ files_id: 1, n: 1 });

  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
});

async function cleanupExpiredFiles() {
  if (!conn.db) return;

  const expiryTime = Date.now() - (LINK_EXPIRY_MINUTES * 60 * 1000);

  const oldFiles = await conn.db.collection('uploads.files').find({
    'metadata.createdAt': { $lt: new Date(expiryTime) }
  }).toArray();

  for (const file of oldFiles) {
    try {
      await gfs.delete(file._id);
      console.log(`Deleted expired file: ${file.filename}`);
    } catch (err) {
      console.error(`Failed to delete expired file ${file._id}:`, err);
    }
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send("No file uploaded");

  cleanupExpiredFiles().catch(console.error);

  const uploadStream = gfs.openUploadStream(file.originalname, {
    chunkSizeBytes: 1024 * 1024,  // 1MB chunks
    metadata: {
      originalname: file.originalname,
      contentType: file.mimetype,
      createdAt: new Date(),
      accessCount: 0
    }
  });

  uploadStream.end(file.buffer);
  const id = uploadStream.id.toString();
  // ✅ Respond only after file upload is fully finished
  uploadStream.on('finish', async () => {
    const fileId = uploadStream.id.toString();
    const downloadUrl = `${req.protocol}://${req.get('host')}/d/${fileId}`;
    const qrCode = await qrcode.toDataURL(downloadUrl, {
    color: {
      dark: '#000000',
      light: '#fffaf0'
    },
    margin: 1
  });

    res.send(`
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Download QR</title>
    <meta http-equiv="Cache-Control" content="no-store" />
    <link rel="icon" href="/favicon.ico" type="image/x-icon">
    <style>
      body {
        background-color: #fff9e6;
        display: flex;
        justify-content: center;
        align-items: center;
        min-height: 100vh;
        font-family: 'Roboto', sans-serif;
        overflow: hidden;
      }
      .card {
        width: 400px;
        background: rgb(255, 250, 235);
        box-shadow: 0 12px 26px rgba(0, 0, 0, 0.1);
        border-radius: 19px;
        padding: 30px;
        text-align: center;
      }
      .qr-container {
        width: 120px;
        height: 120px;
        margin: 20px auto;
        transition: transform 0.3s ease;
      }
      .qr-container:hover {
        transform: scale(1.5);
      }
      .qr-container img {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }
      .copy-btn {
        margin-top: 10px;
        background-color: rgba(16, 86, 82, 0.15);
        border: none;
        border-radius: 10px;
        padding: 10px 20px;
        font-weight: 600;
        cursor: pointer;
      }
      .toast {
        position: fixed;
        top: 20px;
        right: 20px;
        background-color: rgba(16, 86, 82, 0.15);
        color: black;
        padding: 14px 24px;
        border-radius: 10px;
        font-size: 14px;
        opacity: 0;
        transform: translateY(-20px);
        transition: opacity 0.3s ease, transform 0.3s ease;
        z-index: 9999;
      }
      .toast.show {
        opacity: 1;
        transform: translateY(0);
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>Scan QR to Access File</h2>
      <div class="qr-container">
        <img src="${qrCode}" alt="QR Code">
      </div>
      <p><strong>OR</strong></p>
      <button class="copy-btn" onclick="copyToClipboard()">Copy Link</button>
      <p>Link expires in ${LINK_EXPIRY_MINUTES} minutes or after first access.</p>
    </div>

    <div id="toast" class="toast"></div>

    <script>
      // One-time view enforcement
      if (sessionStorage.getItem("seen-${id}")) {
        window.location.href = "/";
      } else {
        sessionStorage.setItem("seen-${id}", "true");
      }

      history.replaceState(null, "", location.href);
      window.addEventListener("popstate", () => {
        window.location.href = "/";
      });

      window.addEventListener("beforeunload", () => {
        sessionStorage.removeItem("seen-${id}");
        sessionStorage.setItem("show-leave-toast", "1");
      });

            function copyToClipboard() {
        navigator.clipboard.writeText("${downloadUrl}")
          .then(() => showToast("Link copied to clipboard!"))
          .catch(() => showToast("Failed to copy link."));
      }

      function showToast(message) {
        const toast = document.getElementById("toast");
        toast.textContent = message;
        toast.classList.add("show");
        setTimeout(() => {
          toast.classList.remove("show");
        }, 3000);
      }
    </script>
  </body>
  </html>
  `);
});
});

app.get('/d/:id', async (req, res) => {
  const fileId = req.params.id;
  cleanupExpiredFiles().catch(console.error);

  let objectId;
  try {
    objectId = new ObjectId(fileId);
  } catch {
    return res.send("Invalid download link.");
  }

  const fileDoc = await conn.db.collection('uploads.files').findOne({ _id: objectId });
  if (!fileDoc) return res.send("Link is invalid or expired.");

  const now = Date.now();
  const createdAt = new Date(fileDoc.metadata.createdAt).getTime();
  const expired = (fileDoc.metadata.accessCount >= 1) ||
                  (now - createdAt > LINK_EXPIRY_MINUTES * 60 * 1000);

  if (expired) {
    await gfs.delete(fileDoc._id);
    return res.send("The link has expired.");
  }

  await conn.db.collection('uploads.files').updateOne(
    { _id: objectId },
    { $inc: { "metadata.accessCount": 1 } }
  );

  res.setHeader('Content-Type', fileDoc.metadata.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${fileDoc.metadata.originalname}"`);

  const downloadStream = gfs.openDownloadStream(objectId);

  downloadStream.on('error', (err) => {
    console.error('Error streaming file:', err);
    res.status(500).send('Error downloading file.');
  });

  downloadStream.on('end', async () => {
    try {
      await gfs.delete(objectId);
      console.log(`Deleted file ${fileDoc.metadata.originalname} after download.`);
    } catch (err) {
      console.error('Failed to delete file after download:', err);
    }
  });

  downloadStream.pipe(res);
});
