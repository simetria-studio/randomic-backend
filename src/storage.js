const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

function uploadDir() {
  return process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
}

// v1: local disk. Returns the public URL path.
async function saveFile(buffer, ext) {
  const dir = uploadDir();
  await fs.mkdir(dir, { recursive: true });
  const name = `${crypto.randomUUID()}.${ext}`;
  await fs.writeFile(path.join(dir, name), buffer);
  return `/uploads/${name}`;
}

async function deleteFile(url) {
  try {
    await fs.unlink(path.join(uploadDir(), path.basename(url)));
  } catch {
    /* already gone */
  }
}

module.exports = { saveFile, deleteFile, uploadDir };
