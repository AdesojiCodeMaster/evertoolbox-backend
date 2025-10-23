// ✅ UNIVERSAL-FILETOOL.JS (Optimized + Fixed)


const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const mime = require("mime-types");

const router = express.Router();

// ======================
// Multer setup
// ======================
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => {
      const safe = `${Date.now()}-${uuidv4()}-${file.originalname.replace(/\s+/g, "_")}`;
      cb(null, safe);
    }
  }),
  limits: { fileSize: 250 * 1024 * 1024 }
}).single("file");

// ======================
// Helper utilities
// ======================
function runCmd(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 50, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || stdout || err.message));
      resolve({ stdout, stderr });
    });
  });
}

async function hasCmd(name) {
  try {
    await runCmd(`which ${name}`);
    return true;
  } catch { return false; }
}

async function findMagickCmd() {
  try { await runCmd("magick -version"); return "magick"; }
  catch { return "convert"; }
}

function extOfFilename(name) {
  return path.extname(name || "").replace(".", "").toLowerCase();
}

function sanitizeFilename(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9._\- ]/g, "_");
}

function safeOutputName(originalName, targetExt) {
  const base = path.parse(originalName).name.replace(/\s+/g, "_");
  return `${base}.${targetExt}`;
}

function fixOutputExtension(filename, targetExt) {
  const clean = filename.replace(/\.[^/.]+$/, "");
  return `${clean}.${targetExt}`;
}

async function ensureProperExtension(filePath, targetExt) {
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  const correct = (targetExt || "").replace('.', '').toLowerCase();
  if (!ext || ext !== correct) {
    const fixed = `${filePath}.${correct}`;
    try {
      await fsp.rename(filePath, fixed);
      console.log(`🔧 Fixed extension: ${fixed}`);
      return fixed;
    } catch {}
  }
  return filePath;
}

async function safeCleanup(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      await fsp.unlink(filePath);
      console.log(`🧹 Temp deleted: ${filePath}`);
    }
  } catch {}
}

// ======================
// Type sets
// ======================
const imageExts = new Set(["jpg","jpeg","png","webp","gif","tiff","bmp","pdf"]);
const audioExts = new Set(["mp3","wav","m4a","ogg","opus","webm"]);
const videoExts = new Set(["mp4","avi","mov","webm","mkv"]);
const docExts = new Set(["pdf","docx","txt","md","html"]);

// ======================
// Converters
// ======================

// --- AUDIO ---
async function convertAudio(input, outPath, ext) {
  ext = ext.replace('.', '').toLowerCase();
  const out = fixOutputExtension(outPath, ext);
  let cmd;
  switch (ext) {
    case "wav":
      cmd = `ffmpeg -y -i "${input}" -acodec pcm_s16le -ar 44100 "${out}"`; break;
    case "mp3":
      cmd = `ffmpeg -y -i "${input}" -codec:a libmp3lame -qscale:a 2 "${out}"`; break;
    case "ogg":
      cmd = `ffmpeg -y -i "${input}" -c:a libvorbis -q:a 4 "${out}"`; break;
    case "opus":
      cmd = `ffmpeg -y -i "${input}" -c:a libopus -b:a 96k -f opus "${out}"`; break;
    case "m4a":
      cmd = `ffmpeg -y -i "${input}" -c:a aac -b:a 128k "${out}"`; break;
    case "webm":
      cmd = `ffmpeg -y -i "${input}" -vn -c:a libopus -b:a 96k "${out}"`; break;
    default:
      throw new Error(`Unsupported target audio format: ${ext}`);
  }
  await runCmd(cmd);
  return await ensureProperExtension(out, ext);
}

// --- VIDEO ---
async function convertVideo(input, outPath, ext) {
  ext = ext.replace('.', '').toLowerCase();
  const out = fixOutputExtension(outPath, ext);
  let cmd;

  if (ext === "webm") {
    cmd = `ffmpeg -y -threads 0 -i "${input}" -c:v libvpx-vp9 -b:v 1M -cpu-used 8 -row-mt 1 -c:a libopus -b:a 96k "${out}"`;
  } else if (["mp4","mov","m4v","avi","mkv"].includes(ext)) {
    cmd = `ffmpeg -y -threads 0 -i "${input}" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 128k "${out}"`;
  } else {
    cmd = `ffmpeg -y -i "${input}" -c copy "${out}"`;
  }

  await runCmd(cmd);
  return await ensureProperExtension(out, ext);
}

// --- DOCUMENT ---
async function convertDocument(input, outPath, ext, tmp) {
  const inExt = extOfFilename(input);
  ext = ext.replace('.', '').toLowerCase();

  // ✅ PDF → DOCX faster path
  if (inExt === "pdf" && ext === "docx") {
    if (await hasCmd("pdftotext") && await hasCmd("pandoc")) {
      const midTxt = path.join(tmp, `${path.parse(input).name}.txt`);
      await runCmd(`pdftotext "${input}" "${midTxt}"`);
      await runCmd(`pandoc "${midTxt}" -o "${outPath}"`);
      await fsp.unlink(midTxt).catch(()=>{});
      return outPath;
    }
  }

  // fallback to LibreOffice
  const cmd = `libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to ${ext} "${input}" --outdir "${tmp}"`;
  await runCmd(cmd);
  const gen = path.join(tmp, `${path.parse(input).name}.${ext}`);
  if (!fs.existsSync(gen)) throw new Error(`LibreOffice failed PDF→${ext}`);
  await fsp.rename(gen, outPath);
  return outPath;
}

// --- PDF Compression ---
async function compressPdf(input, outPath) {
  const cmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outPath}" "${input}"`;
  await runCmd(cmd);
  return outPath;
}

// ======================
// Route handler
// ======================
router.post("/", (req, res) => {
  upload(req, res, async function (err) {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    const mode = (req.body.mode || "convert").toLowerCase();
    const targetFormat = (req.body.targetFormat || "").replace('.', '').toLowerCase();
    const inputPath = req.file.path;
    const originalName = sanitizeFilename(req.file.originalname);
    const inputExt = extOfFilename(originalName);
    const tmpDir = path.dirname(inputPath);

    const magickCmd = await findMagickCmd();
    const outBase = path.join(os.tmpdir(), `${Date.now()}-${uuidv4()}-${safeOutputName(originalName, targetFormat || inputExt)}`);
    const outPath = fixOutputExtension(outBase, targetFormat || inputExt);

    let producedPath;

    try {
      if (audioExts.has(inputExt) || audioExts.has(targetFormat)) {
        producedPath = (mode === "convert")
          ? await convertAudio(inputPath, outPath, targetFormat)
          : await convertAudio(inputPath, outPath, inputExt);
      } else if (videoExts.has(inputExt) || videoExts.has(targetFormat)) {
        producedPath = (mode === "convert")
          ? await convertVideo(inputPath, outPath, targetFormat)
          : await convertVideo(inputPath, outPath, inputExt);
      } else if (docExts.has(inputExt) || docExts.has(targetFormat)) {
        producedPath = (mode === "convert")
          ? await convertDocument(inputPath, outPath, targetFormat, tmpDir)
          : await compressPdf(inputPath, outPath);
      } else {
        throw new Error(`Unsupported file type: .${inputExt}`);
      }

      if (!fs.existsSync(producedPath)) throw new Error("Output not found.");
      producedPath = await ensureProperExtension(producedPath, targetFormat);

      const fileName = safeOutputName(originalName, extOfFilename(producedPath));
      const stat = fs.statSync(producedPath);
      const mimeType = mime.lookup(fileName) || "application/octet-stream";

      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${fileName}"`,
      });

      const stream = fs.createReadStream(producedPath);
      stream.pipe(res);
      stream.on("close", async () => await safeCleanup(producedPath));
    } catch (e) {
      console.error("❌ Conversion error:", e.message);
      await safeCleanup(inputPath);
      if (!res.headersSent)
        res.status(500).json({ error: e.message });
    }
  });
});

module.exports = router;
