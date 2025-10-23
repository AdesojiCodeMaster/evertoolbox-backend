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
      if (err) {
        const message = (stderr && stderr.toString()) || (stdout && stdout.toString()) || err.message;
        return reject(new Error(message));
      }
      resolve({ stdout: stdout ? stdout.toString() : "", stderr: stderr ? stderr.toString() : "" });
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
  catch { try { await runCmd("convert -version"); return "convert"; } catch { return null; } }
}

function extOfFilename(name) {
  return path.extname(name || "").replace(".", "").toLowerCase();
}

function sanitizeFilename(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9._\- ]/g, "_");
}

function safeOutputName(originalName, targetExt) {
  const base = path.parse(originalName).name.replace(/\s+/g, "_");
  const cleanExt = (targetExt || "").replace(/^\./, "");
  return cleanExt ? `${base}.${cleanExt}` : `${base}`;
}

function fixOutputExtension(filename, targetExt) {
  const dir = path.dirname(filename);
  const base = path.parse(filename).name;
  const cleanExt = (targetExt || "").replace(/^\./, "");
  return cleanExt ? path.join(dir, `${base}.${cleanExt}`) : filename;
}

async function ensureProperExtension(filePath, targetExt) {
  try {
    if (!filePath) return filePath;
    const dir = path.dirname(filePath);
    const base = path.parse(filePath).name; // removes existing extension
    const clean = (targetExt || "").replace(/^\./, "").toLowerCase();
    if (!clean) return filePath;
    const newPath = path.join(dir, `${base}.${clean}`);
    if (newPath === filePath) return filePath;
    // only rename if file exists
    if (fs.existsSync(filePath)) {
      await fsp.rename(filePath, newPath);
      console.log(`🔧 Fixed extension: ${newPath}`);
      return newPath;
    }
  } catch (err) { /* ignore */ }
  return filePath;
}

async function safeCleanup(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      await fsp.unlink(filePath);
      console.log(`🧹 Temp deleted: ${filePath}`);
    }
  } catch (err) { console.warn('cleanup failed', err && err.message); }
}

// ======================
// Type sets
// ======================
const imageExts = new Set(["jpg","jpeg","png","webp","gif","tiff","bmp"]);
const audioExts = new Set(["mp3","wav","m4a","ogg","opus","webm"]);
const videoExts = new Set(["mp4","avi","mov","webm","mkv","m4v"]);
const officeExts = new Set(["doc","docx","ppt","pptx","xls","xlsx","odt","ods","odp"]);
const docExts = new Set(["pdf","txt","md","html"]); // pdf + text-like

// ======================
// Pre-warm & environment checks
// ======================
(async function prewarm() {
  try {
    console.log('🔥 Prewarming conversion tools...');
    await Promise.allSettled([
      runCmd('ffmpeg -version'),
      runCmd('libreoffice --headless --version').catch(()=>{}),
      runCmd('pdftoppm -v').catch(()=>{}),
      runCmd('pdftotext -v').catch(()=>{}),
      runCmd('convert -version').catch(()=>{}),
      runCmd('gs --version').catch(()=>{}),
    ]);
    console.log('🔥 Tools prewarm complete');
  } catch (e) {
    console.warn('Prewarm notice:', e && e.message);
  }
})();

// ======================
// Converters
// ======================

// --- AUDIO ---
async function convertAudio(input, outPath, ext) {
  if (!fs.existsSync(input)) throw new Error('Input file not found');
  ext = (ext || path.extname(outPath)).replace('.', '').toLowerCase();
  if (!ext) throw new Error('No target audio extension specified');
  const out = fixOutputExtension(outPath, ext);
  let cmd;
  switch (ext) {
    case "wav":
      cmd = `ffmpeg -y -threads 2 -i "${input}" -acodec pcm_s16le -ar 44100 "${out}"`;
      break;
    case "mp3":
      cmd = `ffmpeg -y -threads 2 -i "${input}" -codec:a libmp3lame -qscale:a 2 "${out}"`;
      break;
    case "ogg":
      cmd = `ffmpeg -y -threads 2 -i "${input}" -c:a libvorbis -q:a 4 "${out}"`;
      break;
    case "opus":
      // use .opus extension and libopus codec
      cmd = `ffmpeg -y -threads 2 -i "${input}" -c:a libopus -b:a 96k -vn "${out}"`;
      break;
    case "m4a":
      cmd = `ffmpeg -y -threads 2 -i "${input}" -c:a aac -b:a 128k "${out}"`;
      break;
    case "webm":
      cmd = `ffmpeg -y -threads 2 -i "${input}" -vn -c:a libopus -b:a 96k "${out}"`;
      break;
    default:
      throw new Error(`Unsupported target audio format: ${ext}`);
  }
  console.log('🎬 ffmpeg (audio):', cmd);
  const { stderr } = await runCmd(cmd).catch(err => { throw new Error(err.message); });
  if (stderr) console.log('ffmpeg stderr:', stderr.slice(0, 2000));
  return await ensureProperExtension(out, ext);
}

// --- VIDEO ---
async function convertVideo(input, outPath, ext) {
  if (!fs.existsSync(input)) throw new Error('Input file not found');
  ext = (ext || path.extname(outPath)).replace('.', '').toLowerCase();
  if (!ext) throw new Error('No target video extension specified');
  const out = fixOutputExtension(outPath, ext);
  let cmd;

  if (ext === "webm") {
    // use vp8 for speed, vp9 is slower; libopus for audio
    cmd = `ffmpeg -y -threads 2 -i "${input}" -c:v libvpx -b:v 1M -cpu-used 5 -threads 2 -row-mt 1 -c:a libopus -b:a 96k "${out}"`;
  } else if (["mp4","mov","m4v","avi","mkv"].includes(ext)) {
    // fast preset for speed
    cmd = `ffmpeg -y -threads 2 -i "${input}" -c:v libx264 -preset fast -crf 28 -c:a aac -b:a 128k "${out}"`;
  } else {
    cmd = `ffmpeg -y -i "${input}" -c copy "${out}"`;
  }

  console.log('🎬 ffmpeg (video):', cmd);
  const { stderr } = await runCmd(cmd).catch(err => { throw new Error(err.message); });
  if (stderr) console.log('ffmpeg stderr:', stderr.slice(0, 2000));
  return await ensureProperExtension(out, ext);
}

// --- DOCUMENT ---
async function convertDocument(input, outPath, targetExt, tmp) {
  if (!fs.existsSync(input)) throw new Error('Input file not found');
  const inExt = extOfFilename(input) || extOfFilename(path.basename(input));
  const ext = (targetExt || path.extname(outPath)).replace('.', '').toLowerCase();
  const out = fixOutputExtension(outPath, ext);

  // PDF → Images (png/jpg/webp)
  if (inExt === 'pdf' && ['png','jpg','jpeg','webp'].includes(ext)) {
    // use pdftoppm
    const base = path.join(tmp, `${path.parse(input).name}`);
    const format = ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext;
    const cmd = `pdftoppm -png "${input}" "${base}"`;
    // pdftoppm produces multiple pages: base-1.png, base-2.png; if single page, rename
    console.log('📄 pdftoppm:', cmd);
    await runCmd(cmd).catch(err => { throw new Error('pdftoppm failed: ' + err.message); });
    // pick first page output
    const pageFile = `${base}-1.${format}`;
    if (!fs.existsSync(pageFile)) {
      // try variations
      const alt = `${base}.png`;
      if (fs.existsSync(alt)) {
        await fsp.rename(alt, out);
        return out;
      }
      throw new Error('pdftoppm did not produce page image');
    }
    await fsp.rename(pageFile, out);
    return out;
  }

  // PDF → Text or Markdown
  if (inExt === 'pdf' && ['txt','md'].includes(ext)) {
    const mid = path.join(tmp, `${path.parse(input).name}.txt`);
    if (await hasCmd('pdftotext')) {
      await runCmd(`pdftotext "${input}" "${mid}"`).catch(err => { throw new Error('pdftotext failed: ' + err.message); });
      if (ext === 'md') {
        // Convert txt to md via pandoc if available, else return txt
        if (await hasCmd('pandoc')) {
          await runCmd(`pandoc "${mid}" -o "${out}"`).catch(err => { throw new Error('pandoc failed: ' + err.message); });
          await fsp.unlink(mid).catch(()=>{});
          return out;
        }
      }
      await fsp.rename(mid, out);
      return out;
    }
  }

  // PDF → DOCX via pdftotext + pandoc (faster path if available)
  if (inExt === 'pdf' && ext === 'docx') {
    if (await hasCmd('pdftotext') && await hasCmd('pandoc')) {
      const midTxt = path.join(tmp, `${path.parse(input).name}.txt`);
      await runCmd(`pdftotext "${input}" "${midTxt}"`);
      await runCmd(`pandoc "${midTxt}" -o "${out}"`);
      await fsp.unlink(midTxt).catch(()=>{});
      return out;
    }
  }

  // Office conversions (docx,pptx,xlsx, etc.) and fallbacks
  if (officeExts.has(inExt) || officeExts.has(ext) || (!officeExts.has(inExt) && inExt === 'pdf')) {
    // use LibreOffice as fallback
    const cmd = `libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to ${ext} "${input}" --outdir "${tmp}"`;
    console.log('📄 libreoffice:', cmd);
    await runCmd(cmd).catch(err => { throw new Error('LibreOffice conversion failed: ' + err.message); });
    const gen = path.join(tmp, `${path.parse(input).name}.${ext}`);
    if (!fs.existsSync(gen)) throw new Error(`LibreOffice failed to produce ${ext}`);
    await fsp.rename(gen, out);
    return out;
  }

  throw new Error(`Unsupported document conversion: ${inExt} -> ${ext}`);
}

// --- PDF Compression ---
async function compressPdf(input, outPath) {
  if (!fs.existsSync(input)) throw new Error('Input file not found');
  const cmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outPath}" "${input}"`;
  console.log('🔧 Ghostscript:', cmd);
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
    const outBase = path.join(os.tmpdir(), `${Date.now()}-${uuidv4()}-${path.parse(originalName).name}`);
    // if targetFormat provided, ensure outPath has that extension; otherwise keep input ext
    const effectiveTarget = targetFormat || inputExt;
    const outPath = fixOutputExtension(outBase, effectiveTarget);

    let producedPath;

    try {
      // Route by type: prioritize explicit target formats too
      if (audioExts.has(inputExt) || audioExts.has(effectiveTarget)) {
        producedPath = (mode === "convert")
          ? await convertAudio(inputPath, outPath, effectiveTarget)
          : await convertAudio(inputPath, outPath, inputExt);
      } else if (videoExts.has(inputExt) || videoExts.has(effectiveTarget)) {
        producedPath = (mode === "convert")
          ? await convertVideo(inputPath, outPath, effectiveTarget)
          : await convertVideo(inputPath, outPath, inputExt);
      } else if (inputExt === 'pdf' || docExts.has(inputExt) || docExts.has(effectiveTarget) || officeExts.has(effectiveTarget)) {
        // document/pdf handling
        if (mode === 'compress' && inputExt === 'pdf') {
          producedPath = await compressPdf(inputPath, outPath);
        } else {
          producedPath = await convertDocument(inputPath, outPath, effectiveTarget, tmpDir);
        }
      } else if (imageExts.has(inputExt) || imageExts.has(effectiveTarget)) {
        // image conversions via ImageMagick
        if (!magickCmd) throw new Error('ImageMagick not available');
        const cmd = `${magickCmd} "${inputPath}" "${outPath}"`;
        console.log('🖼️ imagemagick:', cmd);
        await runCmd(cmd);
        producedPath = await ensureProperExtension(outPath, effectiveTarget);
      } else {
        throw new Error(`Unsupported file type: .${inputExt}`);
      }

      if (!fs.existsSync(producedPath)) throw new Error("Output not found.");

      // Ensure extension matches requested target (if provided)
      const finalTarget = targetFormat || extOfFilename(producedPath) || inputExt;
      producedPath = await ensureProperExtension(producedPath, finalTarget);

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
      stream.on("close", async () => {
        await safeCleanup(producedPath);
        await safeCleanup(inputPath);
      });
      stream.on("error", async (err) => {
        console.error('Stream error:', err && err.message);
        await safeCleanup(producedPath);
        await safeCleanup(inputPath);
      });
    } catch (e) {
      console.error("❌ Conversion error:", e && e.message);
      await safeCleanup(inputPath);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });
});

module.exports = router;
    
