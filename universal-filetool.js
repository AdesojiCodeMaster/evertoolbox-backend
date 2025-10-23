// universal-filetool.js (final + compression for all types)
// Single-route universal file conversion & heavy compression - production-ready
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

// prefer /dev/shm for speed if available
const TMP_DIR = process.env.TMPDIR || (fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir());
const FFMPEG_THREADS = process.env.FFMPEG_THREADS || 2;

// ----------------------
// Multer (upload)
// ----------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => {
      const safeBase = `${Date.now()}-${uuidv4()}-${file.originalname.replace(/\s+/g, "_")}`;
      cb(null, safeBase);
    }
  }),
  limits: { fileSize: 1024 * 1024 * 1024 } // 1 GB max (adjust if needed)
}).single("file");

// ----------------------
// Command runner helper
// ----------------------
function runCmd(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
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
  const clean = (targetExt || "").toString().replace(/^\./, "").toLowerCase();
  if (!clean) return filename;
  const dir = path.dirname(filename);
  const base = path.parse(filename).name;
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
const audioExts = new Set(["mp3","wav","m4a","ogg","opus","flac","aac","webm"]);
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

  // Guarantee out contains extension BEFORE running ffmpeg
  let out = fixOutputExtension(outPath, ext);

  // ensure extension appended
  if (!path.extname(out).toLowerCase()) out = `${out}.${ext}`;

  let cmd;
  switch (ext) {
    case "wav":
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -acodec pcm_s16le -ar 44100 "${out}"`;
      break;
    case "mp3":
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -codec:a libmp3lame -qscale:a 2 "${out}"`;
      break;
    case "ogg":
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:a libvorbis -q:a 4 "${out}"`;
      break;
    case "opus":
      // enforce .opus extension and native opus container
      out = fixOutputExtension(out, "opus");
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:a libopus -b:a 96k -vn -f opus "${out}"`;
      break;
    case "m4a":
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:a aac -b:a 128k "${out}"`;
      break;
    case "flac":
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:a flac "${out}"`;
      break;
    case "webm":
      out = fixOutputExtension(out, "webm");
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -vn -c:a libopus -b:a 96k -f webm "${out}"`;
      break;
    default:
      throw new Error(`Unsupported target audio format: ${ext}`);
  }

  console.log("🎬 ffmpeg (audio):", cmd);
  const { stderr } = await runCmd(cmd).catch(err => { throw new Error(err.message); });
  if (stderr) console.log("ffmpeg stderr:", stderr.slice(0, 2000));

  // Validate output
  if (!fs.existsSync(out)) throw new Error("Audio conversion failed: output missing");
  const s = fs.statSync(out);
  if (!s || s.size === 0) throw new Error("Audio conversion failed: output empty");

  return await ensureProperExtension(out, ext);
}

// VIDEO
async function convertVideo(input, outPath, targetExt) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  const ext = (targetExt || path.extname(outPath)).toString().replace(/^\./, "").toLowerCase();
  if (!ext) throw new Error("No target video extension specified");

  // Guarantee out contains extension BEFORE running ffmpeg
  let out = fixOutputExtension(outPath, ext);
  if (!path.extname(out).toLowerCase()) out = `${out}.${ext}`;

  let cmd;

  if (ext === "webm") {
    // VP8 for speed; VP9 yields better compression but is slower. Use libvpx (vp8) with realtime options for faster encodes.
    cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libvpx -b:v 800k -cpu-used 5 -threads ${FFMPEG_THREADS} -row-mt 1 -c:a libopus -b:a 96k -f webm "${out}"`;
  } else if (ext === "mkv") {
    // MKV using x264 (fast)
    cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 96k "${out}"`;
  } else if (["mp4","mov","m4v","avi"].includes(ext)) {
    // Fast mp4
    cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libx264 -preset fast -crf 28 -c:a aac -b:a 128k "${out}"`;
  } else {
    // container copy
    cmd = `ffmpeg -y -i "${input}" -c copy "${out}"`;
  }

  console.log("🎬 ffmpeg (video):", cmd);
  const { stderr } = await runCmd(cmd).catch(err => { throw new Error(err.message); });
  if (stderr) console.log("ffmpeg stderr:", stderr.slice(0, 2000));

  if (!fs.existsSync(out)) throw new Error("Video conversion failed: output missing");
  const s = fs.statSync(out);
  if (!s || s.size === 0) throw new Error("Video conversion failed: output empty");

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
    const cmd = `pdftoppm -f 1 -singlefile -${format} "${input}" "${prefix}"`;
    console.log("📄 pdftoppm:", cmd);
    await runCmd(cmd).catch(err => { throw new Error(`pdftoppm failed: ${err.message}`); });
    const produced = `${prefix}.${format}`;
    if (!fs.existsSync(produced)) {
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

  // PDF -> docx via pdftotext + pandoc
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

// ----------------------
// Compression (heavy, replica-preserving)
// Overwrites same extension (Option 1)
// ----------------------
async function compressFile(input, outPath, inputExt) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  inputExt = (inputExt || extOfFilename(input)).replace(/^\./, "").toLowerCase();
  // outPath will be overwritten but keep same extension
  const out = fixOutputExtension(outPath, inputExt);

  let cmd;

  // PDF - aggressive (screen)
  if (inputExt === "pdf") {
    // /screen is most aggressive (72 dpi); use /ebook for milder
    cmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${out}" "${input}"`;
  }
  // Image compression - JPEG/WebP/PNG
  else if (imageExts.has(inputExt) || ["jpg","jpeg","png","webp"].includes(inputExt)) {
    // Aggressive JPEG: strip metadata, reduce quality to 60, sampling factor for smaller size
    if (["jpg", "jpeg"].includes(inputExt)) {
      cmd = `magick "${input}" -strip -sampling-factor 4:2:0 -quality 60 -interlace Plane -colorspace sRGB "${out}"`;
    } else if (inputExt === "png") {
      // use pngquant if available for better compression; fallback to ImageMagick convert with quality reduce
      if (await hasCmd("pngquant")) {
        cmd = `pngquant --quality=60-80 --output "${out}" --force "${input}"`;
      } else {
        cmd = `magick "${input}" -strip -quality 60 "${out}"`;
      }
    } else if (inputExt === "webp") {
      cmd = `magick "${input}" -strip -quality 60 "${out}"`;
    } else {
      // fallback
      cmd = `magick "${input}" -strip -quality 60 "${out}"`;
    }
  }
  // Audio - reduce bitrate and force stereo 44.1k
  else if (audioExts.has(inputExt)) {
    // For speech/music compromise, use 64-96k depending on original; choose 96k as default
    cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -ac 2 -ar 44100 -b:a 96k "${out}"`;
  }
  // Video - aggressive re-encode with high CRF
  else if (videoExts.has(inputExt)) {
    // Use x264 with high CRF (lower quality but much smaller). Use veryfast preset to save CPU time.
    // If webm, use vp8 for faster encode
    if (inputExt === "webm") {
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libvpx -b:v 600k -cpu-used 5 -row-mt 1 -c:a libopus -b:a 64k -f webm "${out}"`;
    } else {
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libx264 -preset veryfast -crf 35 -c:a aac -b:a 96k "${out}"`;
    }
  }
  // Office/document - convert to PDF then compress
  else if (officeExts.has(inputExt) || docExts.has(inputExt)) {
    // convert to PDF then compress
    const tmpPdf = fixOutputExtension(outPath, "pdf");
    // prefer pandoc or libreoffice conversion
    if (await hasCmd("pandoc") && docExts.has(inputExt)) {
      await runCmd(`pandoc "${input}" -o "${tmpPdf}"`).catch(()=>{});
    } else {
      // libreoffice fallback
      await runCmd(`libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to pdf "${input}" --outdir "${path.dirname(tmpPdf)}"`).catch(()=>{});
    }
    // compress pdf heavily
    await runCmd(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${tmpPdf}" "${tmpPdf}"`).catch(()=>{});
    // then set out to tmpPdf (rename to original extension if user wants original ext - but user requested overwrite with same extension)
    // We'll keep the original extension but replace content by renaming tmpPdf -> out (same ext). For example: docx -> docx (content is PDF). That's undesirable for non-PDF consumers, so instead:
    // safer: output compressed PDF with same base and .pdf extension
    const compressedPdf = tmpPdf;
    if (!fs.existsSync(compressedPdf)) throw new Error("Document compression failed");
    return compressedPdf; // note: for documents we return a PDF (keeps compressed)
  } else {
    throw new Error(`Compression not supported for .${inputExt}`);
  }

  console.log("🗜️ compress cmd:", cmd);
  await runCmd(cmd).catch(err => { throw new Error(`Compression failed: ${err.message}`); });

  // validate
  if (!fs.existsSync(out)) throw new Error("Compression failed: output missing");
  const s = fs.statSync(out);
  if (!s || s.size === 0) throw new Error("Compression failed: output empty");

  return await ensureProperExtension(out, inputExt);
}

// ----------------------
// Route: single POST '/'
// ----------------------
router.post("/", (req, res) => {
  // disable timeouts for long conversions
  try { req.setTimeout(0); } catch {}
  try { res.setTimeout(0); } catch {}

  upload(req, res, async function (err) {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    const mode = (req.body.mode || "convert").toLowerCase(); // convert | compress
    const requestedTarget = (req.body.targetFormat || "").toString().replace(/^\./, "").toLowerCase();
    const inputPath = req.file.path;
    const originalName = sanitizeFilename(req.file.originalname);
    const inputExt = extOfFilename(originalName) || extOfFilename(inputPath);
    const tmpDir = path.dirname(inputPath);

    const magickCmd = await findMagickCmd();
    const baseOut = path.join(TMP_DIR, safeOutputBase(originalName));
    const effectiveTarget = requestedTarget || inputExt;
    const outPath = fixOutputExtension(baseOut, effectiveTarget);

    let producedPath;

    try {
      if (mode === "compress") {
        // heavy compression for the input file (overwrite same extension)
        producedPath = await compressFile(inputPath, outPath, inputExt);
      } else {
        // convert mode (as before)
        if (audioExts.has(inputExt) || audioExts.has(effectiveTarget)) {
          const target = (mode === "convert") ? effectiveTarget : inputExt;
          producedPath = await convertAudio(inputPath, outPath, target);
        } else if (videoExts.has(inputExt) || videoExts.has(effectiveTarget)) {
          const target = (mode === "convert") ? effectiveTarget : inputExt;
          producedPath = await convertVideo(inputPath, outPath, target);
        } else if (inputExt === "pdf" || docExts.has(inputExt) || docExts.has(effectiveTarget) || officeExts.has(effectiveTarget)) {
          if (mode === "compress" && inputExt === "pdf") {
            producedPath = await compressFile(inputPath, outPath, inputExt);
          } else {
            producedPath = await convertDocument(inputPath, outPath, effectiveTarget, tmpDir);
          }
        } else if (imageExts.has(inputExt) || imageExts.has(effectiveTarget)) {
          if (!magickCmd) throw new Error("ImageMagick not available");
          const cmd = `${magickCmd} "${inputPath}" "${outPath}"`;
          console.log("🖼️ imagemagick:", cmd);
          await runCmd(cmd);
          producedPath = await ensureProperExtension(outPath, effectiveTarget);
        } else {
          throw new Error(`Unsupported file type: .${inputExt}`);
        }
      }

      // validate produced file
      if (!producedPath || !fs.existsSync(producedPath)) throw new Error("Output not produced.");
      const stat = fs.statSync(producedPath);
      if (!stat || stat.size === 0) throw new Error("Produced file is empty.");

      // Ensure final extension matches input extension if compress (overwrite behavior)
      if (mode === "compress") {
        producedPath = await ensureProperExtension(producedPath, inputExt);
      } else {
        const finalTarget = requestedTarget || extOfFilename(producedPath) || inputExt;
        producedPath = await ensureProperExtension(producedPath, finalTarget);
      }

      const fileName = `${path.parse(originalName).name.replace(/\s+/g, "_")}.${extOfFilename(producedPath)}`;
      const mimeType = mapMimeByExt(extOfFilename(producedPath));

      // Stream file to client
      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });

      const stream = fs.createReadStream(producedPath);
      stream.pipe(res);

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
      console.error("❌ Conversion/Compression error:", e && e.message);
      await safeCleanup(inputPath);
      try { if (producedPath) await safeCleanup(producedPath); } catch (er) {}
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });
});

module.exports = router;
