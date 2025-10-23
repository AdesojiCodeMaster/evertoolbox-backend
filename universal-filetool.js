// universal-filetool.js
// Single-route universal file conversion - production-ready
// Requires: ffmpeg, libreoffice, poppler-utils (pdftoppm/pdftotext), ghostscript, imagemagick (magick/convert), pandoc (optional)

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

// ----------------------
// Multer (upload)
// ----------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, process.env.TMPDIR || os.tmpdir()),
    filename: (req, file, cb) => {
      const safeBase = `${Date.now()}-${uuidv4()}-${file.originalname.replace(/\s+/g, "_")}`;
      cb(null, safeBase);
    }
  }),
  limits: { fileSize: 250 * 1024 * 1024 } // 250 MB
}).single("file");

// ----------------------
// Command runner helper
// ----------------------
function runCmd(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 200, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr && stderr.toString()) || (stdout && stdout.toString()) || err.message;
        return reject(new Error(msg));
      }
      resolve({ stdout: stdout ? stdout.toString() : "", stderr: stderr ? stderr.toString() : "" });
    });
  });
}

async function hasCmd(name) {
  try {
    await runCmd(`which ${name}`);
    return true;
  } catch {
    return false;
  }
}

async function findMagickCmd() {
  try { await runCmd("magick -version"); return "magick"; }
  catch {
    try { await runCmd("convert -version"); return "convert"; }
    catch { return null; }
  }
}

// ----------------------
// Utilities
// ----------------------
function extOfFilename(name) {
  return (path.extname(name || "").replace(".", "") || "").toLowerCase();
}

function sanitizeFilename(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9._\- ]/g, "_");
}

function safeOutputBase(originalName) {
  return `${Date.now()}-${uuidv4()}-${path.parse(originalName).name.replace(/\s+/g, "_")}`;
}

function fixOutputExtension(filename, targetExt) {
  // targetExt may be with or without leading dot
  const clean = (targetExt || "").toString().replace(/^\./, "").toLowerCase();
  if (!clean) return filename;
  const dir = path.dirname(filename);
  const base = path.parse(filename).name; // strips existing ext
  return path.join(dir, `${base}.${clean}`);
}

async function ensureProperExtension(filePath, targetExt) {
  try {
    if (!filePath) return filePath;
    const clean = (targetExt || "").toString().replace(/^\./, "").toLowerCase();
    if (!clean) return filePath;
    const dir = path.dirname(filePath);
    const base = path.parse(filePath).name;
    const newPath = path.join(dir, `${base}.${clean}`);
    if (newPath === filePath) return filePath;
    if (fs.existsSync(filePath)) {
      await fsp.rename(filePath, newPath);
      console.log(`🔧 Fixed extension: ${newPath}`);
      return newPath;
    }
  } catch (err) {
    console.warn("ensureProperExtension error:", err && err.message);
  }
  return filePath;
}

async function safeCleanup(filePath) {
  try {
    if (!filePath) return;
    if (fs.existsSync(filePath)) {
      await fsp.unlink(filePath);
      console.log(`🧹 Temp deleted: ${filePath}`);
    }
  } catch (err) {
    console.warn("cleanup failed:", err && err.message);
  }
}

function mapMimeByExt(ext) {
  // explicit mappings for some types
  const e = (ext || "").replace(/^\./, "").toLowerCase();
  if (!e) return "application/octet-stream";
  const map = {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    opus: "audio/opus",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    webm: "video/webm",
    mp4: "video/mp4",
    avi: "video/x-msvideo",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  };
  return map[e] || mime.lookup(e) || "application/octet-stream";
}

// ----------------------
// Type sets
// ----------------------
const imageExts = new Set(["jpg","jpeg","png","webp","gif","tiff","bmp"]);
const audioExts = new Set(["mp3","wav","m4a","ogg","opus"]);
const videoExts = new Set(["mp4","avi","mov","webm","mkv","m4v"]);
const officeExts = new Set(["doc","docx","ppt","pptx","xls","xlsx","odt","ods","odp"]);
const docExts = new Set(["pdf","txt","md","html"]);

// ----------------------
// Prewarm — non-blocking
// ----------------------
(async function prewarm() {
  try {
    console.log("🔥 Prewarming tools (ffmpeg, libreoffice, pdftoppm, pdftotext, convert, gs) ...");
    await Promise.allSettled([
      runCmd("ffmpeg -version"),
      runCmd("libreoffice --headless --version").catch(()=>{}),
      runCmd("pdftoppm -v").catch(()=>{}),
      runCmd("pdftotext -v").catch(()=>{}),
      runCmd("magick -version").catch(()=>runCmd("convert -version").catch(()=>{})),
      runCmd("gs --version").catch(()=>{})
    ]);
    console.log("🔥 Prewarm done");
  } catch (e) {
    console.warn("Prewarm notice:", e && e.message);
  }
})();

// ----------------------
// Converters
// ----------------------

// AUDIO
async function convertAudio(input, outPath, targetExt) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  const ext = (targetExt || path.extname(outPath)).toString().replace(/^\./, "").toLowerCase();
  if (!ext) throw new Error("No target audio extension specified");

  const out = fixOutputExtension(outPath, ext);

  let cmd;
  switch (ext) {
    case "wav":
      cmd = `ffmpeg -y -threads ${process.env.FFMPEG_THREADS || 2} -i "${input}" -acodec pcm_s16le -ar 44100 "${out}"`;
      break;
    case "mp3":
      cmd = `ffmpeg -y -threads ${process.env.FFMPEG_THREADS || 2} -i "${input}" -codec:a libmp3lame -qscale:a 2 "${out}"`;
      break;
    case "ogg":
      // Vorbis in Ogg
      cmd = `ffmpeg -y -threads ${process.env.FFMPEG_THREADS || 2} -i "${input}" -c:a libvorbis -q:a 4 "${out}"`;
      break;
    case "opus":
      // produce native .opus container explicitly
      cmd = `ffmpeg -y -threads ${process.env.FFMPEG_THREADS || 2} -i "${input}" -c:a libopus -b:a 96k -vn -f opus "${out}"`;
      break;
    case "m4a":
      cmd = `ffmpeg -y -threads ${process.env.FFMPEG_THREADS || 2} -i "${input}" -c:a aac -b:a 128k "${out}"`;
      break;
    case "webm":
      // audio-only webm with libopus
      cmd = `ffmpeg -y -threads ${process.env.FFMPEG_THREADS || 2} -i "${input}" -vn -c:a libopus -b:a 96k -f webm "${out}"`;
      break;
    default:
      throw new Error(`Unsupported target audio format: ${ext}`);
  }

  console.log("🎬 ffmpeg (audio):", cmd);
  const { stderr } = await runCmd(cmd).catch(err => { throw new Error(err.message); });
  if (stderr) console.log("ffmpeg stderr:", stderr.slice(0, 2000));
  return await ensureProperExtension(out, ext);
}

// VIDEO
async function convertVideo(input, outPath, targetExt) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  const ext = (targetExt || path.extname(outPath)).toString().replace(/^\./, "").toLowerCase();
  if (!ext) throw new Error("No target video extension specified");

  const out = fixOutputExtension(outPath, ext);

  let cmd;

  if (ext === "webm") {
    // Use VP9 (libvpx-vp9) for better compatibility if available; fallback to vp8 if needed
    // Explicitly force webm container
    // Make settings moderate for speed
    cmd = `ffmpeg -y -threads ${process.env.FFMPEG_THREADS || 2} -i "${input}" -c:v libvpx-vp9 -b:v 1M -cpu-used 4 -row-mt 1 -c:a libopus -b:a 96k -f webm "${out}"`;
  } else if (["mp4","mov","m4v","avi","mkv"].includes(ext)) {
    // MP4/MOV/MKV: re-encode with fast preset for speed
    cmd = `ffmpeg -y -threads ${process.env.FFMPEG_THREADS || 2} -i "${input}" -c:v libx264 -preset fast -crf 28 -c:a aac -b:a 128k "${out}"`;
  } else {
    // default: stream copy (container change only)
    cmd = `ffmpeg -y -i "${input}" -c copy "${out}"`;
  }

  console.log("🎬 ffmpeg (video):", cmd);
  const { stderr } = await runCmd(cmd).catch(err => { throw new Error(err.message); });
  if (stderr) console.log("ffmpeg stderr:", stderr.slice(0, 2000));
  return await ensureProperExtension(out, ext);
}

// DOCUMENT (pdf/image/text/office)
async function convertDocument(input, outPath, targetExt, tmpDir) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  const inExt = extOfFilename(input) || extOfFilename(path.basename(input));
  const ext = (targetExt || path.extname(outPath)).toString().replace(/^\./, "").toLowerCase();
  const out = fixOutputExtension(outPath, ext);
  tmpDir = tmpDir || path.dirname(input);

  // PDF -> images
  if (inExt === "pdf" && ["png","jpg","jpeg","webp"].includes(ext)) {
    const format = (ext === "jpg" || ext === "jpeg") ? "jpeg" : ext;
    const prefix = path.join(tmpDir, safeOutputBase(path.parse(input).name));
    // Use pdftoppm with explicit format
    const cmd = `pdftoppm -f 1 -singlefile -${format} "${input}" "${prefix}"`;
    console.log("📄 pdftoppm:", cmd);
    // run and check output
    await runCmd(cmd).catch(err => { throw new Error(`pdftoppm failed: ${err.message}`); });
    const produced = `${prefix}.${format}`;
    if (!fs.existsSync(produced)) {
      // fallback: try without -singlefile (multi-page)
      const alt = `${prefix}-1.${format}`;
      if (fs.existsSync(alt)) {
        await fsp.rename(alt, out);
        return out;
      }
      throw new Error("pdftoppm did not produce page image");
    }
    await fsp.rename(produced, out);
    return out;
  }

  // PDF -> text / md
  if (inExt === "pdf" && ["txt","md"].includes(ext)) {
    if (await hasCmd("pdftotext")) {
      const mid = path.join(tmpDir, `${safeOutputBase(path.parse(input).name)}.txt`);
      await runCmd(`pdftotext "${input}" "${mid}"`).catch(err => { throw new Error(`pdftotext failed: ${err.message}`); });
      if (ext === "md" && await hasCmd("pandoc")) {
        await runCmd(`pandoc "${mid}" -o "${out}"`).catch(err => { throw new Error(`pandoc failed: ${err.message}`); });
        await fsp.unlink(mid).catch(()=>{});
        return out;
      }
      await fsp.rename(mid, out);
      return out;
    } else {
      throw new Error("pdftotext not available for PDF->text conversion");
    }
  }

  // PDF -> docx faster path (pdftotext + pandoc)
  if (inExt === "pdf" && ext === "docx") {
    if (await hasCmd("pdftotext") && await hasCmd("pandoc")) {
      const mid = path.join(tmpDir, `${safeOutputBase(path.parse(input).name)}.txt`);
      await runCmd(`pdftotext "${input}" "${mid}"`);
      await runCmd(`pandoc "${mid}" -o "${out}"`);
      await fsp.unlink(mid).catch(()=>{});
      return out;
    }
  }

  // Office conversions via LibreOffice fallback
  if (officeExts.has(inExt) || officeExts.has(ext) || inExt === "pdf") {
    // Avoid re-running if we already have it
    if (fs.existsSync(out)) return out;
    const cmd = `libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to ${ext} "${input}" --outdir "${tmpDir}"`;
    console.log("📄 libreoffice:", cmd);
    await runCmd(cmd).catch(err => { throw new Error(`LibreOffice conversion failed: ${err.message}`); });
    const gen = path.join(tmpDir, `${path.parse(input).name}.${ext}`);
    if (!fs.existsSync(gen)) throw new Error(`LibreOffice failed to produce ${ext}`);
    await fsp.rename(gen, out);
    return out;
  }

  throw new Error(`Unsupported document conversion: ${inExt} -> ${ext}`);
}

// PDF compress
async function compressPdf(input, outPath) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  const cmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outPath}" "${input}"`;
  console.log("🔧 Ghostscript:", cmd);
  await runCmd(cmd);
  return outPath;
}

// ----------------------
// Route: single POST '/'
// ----------------------
router.post("/", (req, res) => {
  upload(req, res, async function (err) {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    const mode = (req.body.mode || "convert").toLowerCase();
    const requestedTarget = (req.body.targetFormat || "").toString().replace(/^\./, "").toLowerCase();
    const inputPath = req.file.path;
    const originalName = sanitizeFilename(req.file.originalname);
    const inputExt = extOfFilename(originalName) || extOfFilename(inputPath);
    const tmpDir = path.dirname(inputPath);

    const magickCmd = await findMagickCmd();
    const baseOut = path.join(process.env.TMPDIR || os.tmpdir(), safeOutputBase(originalName));
    // effective target: if no requested target, default to inputExt (copy/normalize)
    const effectiveTarget = requestedTarget || inputExt;
    const outPath = fixOutputExtension(baseOut, effectiveTarget);

    let producedPath;

    try {
      // Route: audio, video, document, image
      if (audioExts.has(inputExt) || audioExts.has(effectiveTarget)) {
        // For audio, if mode is convert -> use requested; else keep same
        const target = (mode === "convert") ? effectiveTarget : inputExt;
        producedPath = await convertAudio(inputPath, outPath, target);
      } else if (videoExts.has(inputExt) || videoExts.has(effectiveTarget)) {
        const target = (mode === "convert") ? effectiveTarget : inputExt;
        producedPath = await convertVideo(inputPath, outPath, target);
      } else if (inputExt === "pdf" || docExts.has(inputExt) || docExts.has(effectiveTarget) || officeExts.has(effectiveTarget)) {
        if (mode === "compress" && inputExt === "pdf") {
          producedPath = await compressPdf(inputPath, outPath);
        } else {
          producedPath = await convertDocument(inputPath, outPath, effectiveTarget, tmpDir);
        }
      } else if (imageExts.has(inputExt) || imageExts.has(effectiveTarget)) {
        // ImageMagick route
        if (!magickCmd) throw new Error("ImageMagick not available");
        const cmd = `${magickCmd} "${inputPath}" "${outPath}"`;
        console.log("🖼️ imagemagick:", cmd);
        await runCmd(cmd);
        producedPath = await ensureProperExtension(outPath, effectiveTarget);
      } else {
        throw new Error(`Unsupported file type: .${inputExt}`);
      }

      if (!producedPath || !fs.existsSync(producedPath)) throw new Error("Output not produced.");

      // Ensure final extension matches requested target (if provided)
      const finalTarget = requestedTarget || extOfFilename(producedPath) || inputExt;
      producedPath = await ensureProperExtension(producedPath, finalTarget);

      const fileName = `${path.parse(originalName).name.replace(/\s+/g, "_")}.${extOfFilename(producedPath)}`;
      const stat = fs.statSync(producedPath);
      const mimeType = mapMimeByExt(extOfFilename(producedPath));

      // Stream file to client with safe headers
      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });

      const stream = fs.createReadStream(producedPath);
      stream.pipe(res);

      // cleanup on finish/error
      const cleanupBoth = async () => {
        await safeCleanup(producedPath);
        await safeCleanup(inputPath);
      };

      res.on("finish", cleanupBoth);
      res.on("close", cleanupBoth);
      stream.on("error", async (err) => {
        console.error("Stream error:", err && err.message);
        await cleanupBoth();
      });

    } catch (e) {
      console.error("❌ Conversion error:", e && e.message);
      await safeCleanup(inputPath);
      // try to remove partial produced file if any
      try { if (producedPath) await safeCleanup(producedPath); } catch (er) {}
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });
});

module.exports = router;
          
