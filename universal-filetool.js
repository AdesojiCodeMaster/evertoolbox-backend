// universal-filetool.js
// CommonJS Express router for EverToolbox front-end.
// Exports a router that is mounted at /api/tools/file by server.js
//
// Required system tools (installed in your Dockerfile):
//  - ffmpeg
//  - imagemagick (convert or magick)
//  - ghostscript (gs)
//  - libreoffice
//  - poppler-utils (pdftoppm / pdftotext) — recommended in Dockerfile
//  - pandoc (optional fallback) — recommended in Dockerfile
//
// Required npm packages: multer, uuid, mime-types
// Install: npm install multer uuid mime-types

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

// Multer setup - single file only, stored to os.tmpdir()
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => {
      const safe = `${Date.now()}-${uuidv4()}-${file.originalname.replace(/\s+/g, "_")}`;
      cb(null, safe);
    }
  }),
  limits: {
    fileSize: 250 * 1024 * 1024 // 250 MB per file by default (adjust if needed)
  }
}).single("file");

// Helper: run shell command, return promise
function runCmd(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 50, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`Command failed: ${cmd}\n${stderr || stdout || err.message}`);
        e.stdout = stdout;
        e.stderr = stderr;
        return reject(e);
      }
      resolve({ stdout, stderr });
    });
  });
}

// Choose ImageMagick binary (prefer magick if available)
async function findMagickCmd() {
  try {
    await runCmd("magick -version");
    return "magick";
  } catch {
    return "convert"; // fallback
  }
}

// Universal output extension fixer (audio/video/image/doc)
function fixOutputExtension(filename, targetFormat) {
  const clean = filename.replace(/\.[^/.]+$/, ""); // remove old extension
  const format = (targetFormat || "").toLowerCase();

  // --- AUDIO ---
  const audioExt = ["wav", "mp3", "opus", "ogg", "m4a"];
  if (audioExt.includes(format)) return `${clean}.${format}`;

  // --- VIDEO ---
  const videoExt = ["mp4", "webm", "avi", "mov", "mkv"];
  if (videoExt.includes(format)) return `${clean}.${format}`;

  // --- IMAGE ---
  const imageExt = ["png", "jpg", "jpeg", "gif", "bmp", "tiff", "webp"];
  if (imageExt.includes(format)) return `${clean}.${format}`;

  // --- DOCUMENT / PDF ---
  const docExt = ["pdf", "docx", "txt", "md", "rtf", "html", "odt", "xlsx", "pptx"];
  if (docExt.includes(format)) return `${clean}.${format}`;

  // Fallback
  return `${clean}.${format || "bin"}`;
}

// Mapping & helpers
const imageExts = new Set(["jpg", "jpeg", "png", "webp", "gif", "tiff", "bmp", "pdf"]);
const audioExts = new Set(['mp3', 'wav', 'm4a', 'ogg', 'opus']);
const videoExts = new Set(["mp4", "avi", "mov", "webm", "mkv"]);
const docExts = new Set(["pdf", "docx", "txt", "md", "html"]);

function extOfFilename(name) {
  const ext = path.extname(name || "").toLowerCase().replace(".", "");
  return ext || "";
}

function sanitizeFilename(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9._\- ]/g, "_");
}

function safeOutputName(originalName, targetExt) {
  const base = path.parse(originalName).name.replace(/\s+/g, "_");
  return `${base}.${targetExt}`;
}

function isSameExt(a, b) {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ✅ Helper: Ensure the output file has the correct extension before sending
async function ensureProperExtension(filePath, targetExt) {
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  const correctExt = (targetExt || "").replace('.', '').toLowerCase();

  // If extension is missing or wrong, rename it
  if (!ext || (correctExt && ext !== correctExt)) {
    const fixedPath = `${filePath}.${correctExt || ext}`;
    try {
      // Only rename if the fixed path doesn't already exist
      if (!fs.existsSync(fixedPath)) {
        await fsp.rename(filePath, fixedPath);
        console.log(`🔧 Fixed file extension: ${fixedPath}`);
        return fixedPath;
      } else {
        // if already exists, just return original path
        console.warn(`⚠️ Not renaming because target exists: ${fixedPath}`);
      }
    } catch (err) {
      console.warn('⚠️ Could not rename file:', err);
    }
  }

  return filePath;
}
  
// ✅ Helper: safely delete temp files after streaming or errors
async function safeCleanup(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      await fsp.unlink(filePath);
      console.log(`🧹 Temp file deleted: ${filePath}`);
    }
  } catch (err) {
    console.warn(`⚠️ Cleanup failed for ${filePath}:`, err.message);
  }
}

// Conversion functions (each returns path to output file)

// Convert PDF first page -> image (png/jpeg/webp/etc).
// If pdftoppm is unavailable, fallback to ImageMagick (magick/convert).
async function convertPdfToImage(inputPath, outPath, targetExt) {
  targetExt = (targetExt || "").replace('.', '').toLowerCase();
  const outputBase = outPath.replace(/\.[^.]+$/, '');
  const correctOutPath = `${outputBase}.${targetExt}`;

  // Try pdftoppm first (fast, safe)
  if (['png', 'jpg', 'jpeg'].includes(targetExt)) {
    const format = targetExt === 'png' ? 'png' : 'jpeg';
    const cmd = `pdftoppm -f 1 -singlefile -${format} "${inputPath}" "${outputBase}"`;
    try {
      await runCmd(cmd);
      if (fs.existsSync(correctOutPath)) return correctOutPath;
      // Try to find generated file
      const dir = path.dirname(outputBase);
      const base = path.basename(outputBase);
      const files = fs.readdirSync(dir);
      const found = files.find(f => f.startsWith(base) && f.endsWith(`.${targetExt}`));
      if (found) return path.join(dir, found);
    } catch (e) {
      console.warn("pdftoppm failed or not available, falling back to ImageMagick:", e.message);
      // fallback below
    }
  }

  // Fallback to ImageMagick's convert/magick for other formats or when pdftoppm missing
  const magickCmd = await findMagickCmd();
  const cmd2 = `${magickCmd} "${inputPath}[0]" -background white -alpha remove -alpha off -flatten -quality 90 "${correctOutPath}"`;
  await runCmd(cmd2);
  return correctOutPath;
}


// Convert image -> pdf
async function convertImageToPdf(inputPath, outPath, magickCmd) {
  // Convert image to PDF
  // Force output to have .pdf extension
  const correctOutPath = outPath.endsWith(".pdf") ? outPath : `${outPath}.pdf`;
  const cmd = `${magickCmd} "${inputPath}" -alpha off -compress jpeg "${correctOutPath}"`;
  await runCmd(cmd);
  return correctOutPath;
}

// Convert generic image -> image format (or pdf handled above elsewhere)
async function convertImage(inputPath, outPath, targetExt, magickCmd) {
  targetExt = (targetExt || "").replace('.', '').toLowerCase();
  // If the input is a PDF, delegate to convertPdfToImage (first page)
  const inputExt = extOfFilename(inputPath).toLowerCase();
  if (inputExt === 'pdf') {
    return await convertPdfToImage(inputPath, outPath, targetExt);
  }

  // Ensure output path ends with the requested extension
  const correctOutPath = outPath.endsWith(`.${targetExt}`) ? outPath : `${outPath}.${targetExt}`;

  // Basic ImageMagick conversions, safe defaults
  const quality = (['webp'].includes(targetExt)) ? 75 : 90;
  let cmd = `${magickCmd} "${inputPath}" -strip -quality ${quality} "${correctOutPath}"`;

  // If converting animated gif -> png, keep first frame only (append [0])
  if (inputExt === 'gif' && ['png', 'jpg', 'jpeg'].includes(targetExt)) {
    cmd = `${magickCmd} "${inputPath}[0]" -strip -quality ${quality} "${correctOutPath}"`;
  }

  await runCmd(cmd);
  return correctOutPath;
}


async function compressImage(inputPath, outPath, targetExt, magickCmd) {
  // Use reasonable quality reductions depending on format
  const outExt = targetExt || extOfFilename(outPath);
  const quality = outExt === "webp" ? 75 : 72;
  const correctOutPath = outPath.endsWith(`.${outExt}`) ? outPath : `${outPath}.${outExt}`;
  const cmd = `${magickCmd} "${inputPath}" -strip -quality ${quality} "${correctOutPath}"`;
  await runCmd(cmd);
  return correctOutPath;
}


async function convertAudio(inputPath, outPath, targetExt) {
  targetExt = (targetExt || "").replace('.', '').toLowerCase();
  const correctOutPath = outPath.endsWith(`.${targetExt}`) ? outPath : `${outPath}.${targetExt}`;

  let cmd;
  switch (targetExt) {
    case 'mp3':
      cmd = `ffmpeg -y -i "${inputPath}" -codec:a libmp3lame -qscale:a 2 "${correctOutPath}"`;
      break;
    case 'wav':
      // produce a .wav (PCM 16-bit)
      cmd = `ffmpeg -y -i "${inputPath}" -acodec pcm_s16le -ar 44100 "${correctOutPath}"`;
      break;
    case 'ogg':
      cmd = `ffmpeg -y -i "${inputPath}" -c:a libvorbis -q:a 4 "${correctOutPath}"`;
      break;
    case 'opus':
      // produce an .opus file (force opus container/format by using .opus filename)
      // add -vbr on for better quality control; ffmpeg will typically choose Ogg/Opus container for .opus
      cmd = `ffmpeg -y -i "${inputPath}" -c:a libopus -b:a 96k -vbr on "${correctOutPath}"`;
      break;
    case 'm4a':
      cmd = `ffmpeg -y -i "${inputPath}" -c:a aac -b:a 128k "${correctOutPath}"`;
      break;
    default:
      throw new Error(`Unsupported target audio format: ${targetExt}`);
  }

  await runCmd(cmd);
  return correctOutPath;
}



async function compressAudio(inputPath, outPath) {
  // Re-encode with lower bitrate for smaller size
  const ext = extOfFilename(outPath) || 'mp3';
  const correctOutPath = outPath.endsWith(`.${ext}`) ? outPath : `${outPath}.${ext}`;
  const targetBitrate = "128k";
  const cmd = `ffmpeg -y -i "${inputPath}" -codec:a libmp3lame -b:a ${targetBitrate} "${correctOutPath}"`;
  await runCmd(cmd);
  return correctOutPath;
}


async function convertVideo(inputPath, outPath, targetExt) {
  // fast, pragmatic conversion settings for Render-like servers
  targetExt = (targetExt || "").replace('.', '').toLowerCase();

  // ensure outPath has extension
  const correctOutPath = outPath.endsWith(`.${targetExt}`) ? outPath : `${outPath}.${targetExt}`;

  let cmd;

  if (targetExt === 'webm') {
    // Use VP8 (libvpx) for speed + libopus audio
    // tuned for faster encode: cpu-used 8 and realtime deadline (fast but lower quality)
    // row-mt speeds up multi-threading
    cmd = `ffmpeg -y -threads 0 -i "${inputPath}" -c:v libvpx -b:v 1M -cpu-used 8 -deadline realtime -row-mt 1 -c:a libopus -b:a 96k "${correctOutPath}"`;
  } else if (['mp4', 'mov', 'm4v', 'avi', 'mkv'].includes(targetExt)) {
    // default to H.264 with ultrafast preset for speed
    cmd = `ffmpeg -y -threads 0 -i "${inputPath}" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 128k "${correctOutPath}"`;
  } else {
    // fallback: copy streams where possible (very fast)
    cmd = `ffmpeg -y -threads 0 -i "${inputPath}" -c copy "${correctOutPath}"`;
  }

  await runCmd(cmd);
  return correctOutPath;
}



async function compressVideo(inputPath, outPath) {
  // Increase CRF to reduce size
  const correctOutPath = outPath; // caller should provide extension
  const cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset medium -crf 28 -c:a aac -b:a 96k "${correctOutPath}"`;
  await runCmd(cmd);
  return correctOutPath;
}

async function convertDocument(inputPath, outPath, targetExt, tempDir) {
  // For docx/html -> pdf use libreoffice (first choice)
  const inExt = extOfFilename(inputPath);
  const targ = (targetExt || "").toLowerCase();

  // pdf target via libreoffice
  if (targ === "pdf" && inExt !== "pdf") {
    const cmd = `libreoffice --headless --convert-to pdf "${inputPath}" --outdir "${tempDir}"`;
    await runCmd(cmd);
    const generated = path.join(tempDir, `${path.parse(inputPath).name}.pdf`);
    if (!fs.existsSync(generated)) throw new Error("LibreOffice did not produce PDF");
    await fsp.rename(generated, outPath);
    return outPath;
  }

  // pdf -> docx/html (prefer libreoffice, fallback to pandoc if available)
  if (inExt === "pdf" && (targ === "docx" || targ === "html")) {
    // try libreoffice first
    try {
      const format = targ === "docx" ? "docx" : "html";
      const cmd = `libreoffice --headless --convert-to ${format} "${inputPath}" --outdir "${tempDir}"`;
      await runCmd(cmd);
      const gen = path.join(tempDir, `${path.parse(inputPath).name}.${format}`);
      if (!fs.existsSync(gen)) throw new Error(`Conversion to ${format} failed`);
      await fsp.rename(gen, outPath);
      return outPath;
    } catch (e) {
      console.warn("LibreOffice conversion failed, trying pandoc (if available):", e.message);
      // try pandoc fallback
      try {
        await runCmd("pandoc --version");
        // pandoc pdf -> docx/html is not always perfect but try
        const pandocFormat = targ === "docx" ? "docx" : "html";
        const cmd2 = `pandoc "${inputPath}" -o "${outPath}"`;
        await runCmd(cmd2);
        if (!fs.existsSync(outPath)) throw new Error("Pandoc did not produce output");
        return outPath;
      } catch (e2) {
        throw new Error(`Conversion to ${targ} failed`);
      }
    }
  }

  // txt/md/html -> pdf via libreoffice
  if ((inExt === "txt" || inExt === "md" || inExt === "html") && targ === "pdf") {
    try {
      const cmd = `libreoffice --headless --convert-to pdf "${inputPath}" --outdir "${tempDir}"`;
      await runCmd(cmd);
      const generated = path.join(tempDir, `${path.parse(inputPath).name}.pdf`);
      if (!fs.existsSync(generated)) throw new Error("LibreOffice conversion failed");
      await fsp.rename(generated, outPath);
      return outPath;
    } catch (e) {
      // fallback: try pandoc (txt/md -> pdf)
      try {
        await runCmd("pandoc --version");
        const cmd2 = `pandoc "${inputPath}" -o "${outPath}"`;
        await runCmd(cmd2);
        if (!fs.existsSync(outPath)) throw new Error("Pandoc conversion failed");
        return outPath;
      } catch (e2) {
        throw new Error("Document conversion failed");
      }
    }
  }

  // pdf -> txt or md using pdftotext or pandoc fallback
  if (inExt === "pdf" && (targ === "txt" || targ === "md")) {
    // try pdftotext (best for plaintext)
    try {
      const txtOut = outPath.endsWith(`.${targ}`) ? outPath : `${outPath}.${targ === 'md' ? 'txt' : 'txt'}`;
      await runCmd(`pdftotext "${inputPath}" "${txtOut}"`);
      if (!fs.existsSync(txtOut)) throw new Error("pdftotext failed");
      // if user asked for md, attempt pandoc to transform txt->md (best-effort)
      if (targ === "md") {
        try {
          await runCmd("pandoc --version");
          const mdOut = outPath.endsWith(".md") ? outPath : `${outPath}.md`;
          await runCmd(`pandoc "${txtOut}" -o "${mdOut}"`);
          if (fs.existsSync(mdOut)) return mdOut;
        } catch {
          // ignore pandoc failure and return txt
        }
      }
      return txtOut;
    } catch (e) {
      // fallback to pandoc directly (might be lossy)
      try {
        await runCmd("pandoc --version");
        const cmd = `pandoc "${inputPath}" -o "${outPath}"`;
        await runCmd(cmd);
        if (!fs.existsSync(outPath)) throw new Error("Pandoc conversion failed");
        return outPath;
      } catch (e2) {
        throw new Error(`Document conversion pdf -> ${targ} not supported on this server`);
      }
    }
  }

  // If user asked for other conversions, try libreoffice generic path
  try {
    const cmd = `libreoffice --headless --convert-to ${targ} "${inputPath}" --outdir "${tempDir}"`;
    await runCmd(cmd);
    const gen = path.join(tempDir, `${path.parse(inputPath).name}.${targ}`);
    if (!fs.existsSync(gen)) throw new Error(`Conversion to ${targ} failed`);
    await fsp.rename(gen, outPath);
    return outPath;
  } catch (e) {
    throw new Error(`Document conversion ${inExt} -> ${targetExt} not supported on this server`);
  }
}

async function compressPdf(inputPath, outPath) {
  const cmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outPath}" "${inputPath}"`;
  await runCmd(cmd);
  return outPath;
}

// Main POST handler
router.post("/", (req, res) => {
  upload(req, res, async function (err) {
    if (err) {
      console.error("Upload error:", err);
      return res.status(400).json({ error: "File upload failed: " + (err.message || err.toString()) });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    const mode = (req.body.mode || "convert").toLowerCase();
    const targetFormatRaw = (req.body.targetFormat || "").toLowerCase();
    const providedTarget = targetFormatRaw || "";
    const tempInput = req.file.path;
    const originalName = sanitizeFilename(req.file.originalname || `upload-${Date.now()}`);
    const inputExt = extOfFilename(originalName);
    const tempDir = path.dirname(tempInput);

    // ensure only single file (multer.single enforces this), but do extra validation:
    if (!req.file || Array.isArray(req.file)) {
      try { await fsp.unlink(tempInput); } catch (_) {}
      return res.status(400).json({ error: "Only a single file upload is allowed." });
    }

    // Validate mode
    if (!["convert", "compress"].includes(mode)) {
      await safeRemove(tempInput);
      return res.status(400).json({ error: "Invalid mode. Must be 'convert' or 'compress'." });
    }

    // If compress mode, ignore any provided targetFormat (frontend disables it). We'll compress in-place format.
    const magickCmd = await findMagickCmd();

    // If convert mode, targetFormat required
    if (mode === "convert" && !providedTarget) {
      await safeRemove(tempInput);
      return res.status(400).json({ error: "Target format is required for conversion." });
    }

    // Prevent same-format conversion
    if (mode === "convert" && providedTarget && isSameExt(inputExt, providedTarget)) {
      await safeRemove(tempInput);
      return res.status(400).json({ error: "Selected target format is the same as uploaded file format. Please choose a different target format." });
    }

    // Determine category
    const targetExt = mode === "convert" ? providedTarget : inputExt; // compress to same ext
    const lowerInputExt = inputExt.toLowerCase();

    // Accept pdf both as doc and image source — so if input or target is pdf we handle accordingly
    const isImageCategory = imageExts.has(lowerInputExt) || imageExts.has(targetExt);
    const isAudioCategory = audioExts.has(lowerInputExt) || audioExts.has(targetExt);
    const isVideoCategory = videoExts.has(lowerInputExt) || videoExts.has(targetExt);
    const isDocCategory = docExts.has(lowerInputExt) || docExts.has(targetExt);

    // Prepare output file path, ensure correct extension using fixer
    const outName = safeOutputName(originalName, targetExt);
    let outPath = path.join(os.tmpdir(), `${Date.now()}-${uuidv4()}-${outName}`);
    outPath = fixOutputExtension(outPath, targetExt);

    let cleanupPaths = [tempInput];
    let producedPath = null;

    // helper to remove a file
    async function safeRemove(p) {
      if (!p) return;
      try { await fsp.unlink(p).catch(()=>{}); } catch (_) {}
    }

    // Cleanup function to remove all temp files
    async function cleanupAll() {
      for (const p of cleanupPaths) {
        try { await safeRemove(p); } catch (_) {}
      }
    }

    // Run conversion/compression with try/catch
    (async () => {
      try {
        // Route by categories
        if (isImageCategory && !isAudioCategory && !isVideoCategory && !isDocCategory) {
          // IMAGE FLOW
          if (mode === "convert") {
            // convert input -> outPath (targetExt)
            producedPath = await convertImage(tempInput, outPath, targetExt, magickCmd);
          } else {
            // compress image (same format)
            producedPath = await compressImage(tempInput, outPath, targetExt, magickCmd);
          }
        } else if (isAudioCategory && !isVideoCategory && !isDocCategory) {
          // AUDIO FLOW
          if (mode === "convert") {
            producedPath = await convertAudio(tempInput, outPath, targetExt);
          } else {
            producedPath = await compressAudio(tempInput, outPath);
          }
        } else if (isVideoCategory && !isAudioCategory && !isDocCategory) {
          // VIDEO FLOW
          if (mode === "convert") {
            producedPath = await convertVideo(tempInput, outPath, targetExt);
          } else {
            producedPath = await compressVideo(tempInput, outPath);
          }
        } else if (isDocCategory || lowerInputExt === "pdf" || targetExt === "pdf") {
          // DOCUMENT/PDF FLOW
          if (mode === "convert") {
            // many conversions map to PDF or from PDF — handle common cases
            if (targetExt === "pdf" && !["pdf"].includes(lowerInputExt)) {
              await convertDocument(tempInput, outPath, "pdf", tempDir);
              producedPath = outPath;
            } else if (lowerInputExt === "pdf" && imageExts.has(targetExt) && targetExt !== "pdf") {
              // pdf -> image (first page)
              producedPath = await convertPdfToImage(tempInput, outPath, targetExt);
            } else if (imageExts.has(lowerInputExt) && targetExt === "pdf") {
              producedPath = await convertImageToPdf(tempInput, outPath, magickCmd);
            } else {
              // Try generic document conversion (libreoffice/pandoc fallbacks)
              producedPath = await convertDocument(tempInput, outPath, targetExt, tempDir);
            }
          } else {
            // compress document -> if pdf, compress with ghostscript
            if (lowerInputExt === "pdf") {
              producedPath = await compressPdf(tempInput, outPath);
            } else {
              // For non-pdf docs: try convert to pdf then compress and return compressed pdf
              const intermediatePdf = path.join(os.tmpdir(), `${Date.now()}-${uuidv4()}-${path.parse(originalName).name}.pdf`);
              cleanupPaths.push(intermediatePdf);
              await convertDocument(tempInput, intermediatePdf, "pdf", tempDir);
              await compressPdf(intermediatePdf, outPath);
              producedPath = outPath;
            }
          }
        } else {
          throw new Error(`Unsupported file type: .${lowerInputExt}`);
        }

        // Ensure file exists and non-zero
        if (!producedPath || !fs.existsSync(producedPath)) throw new Error("Conversion did not produce a result file.");
        const stats = fs.statSync(producedPath);
        if (stats.size === 0) throw new Error("Resulting file is empty (0 bytes).");

        // ✅ Verify and fix missing extension before sending
        producedPath = await ensureProperExtension(producedPath, targetExt);

        const clientFileName = safeOutputName(originalName, extOfFilename(producedPath) || targetExt);

        // ✅ Stream the file and clean up safely afterward
        try {
          const stat = fs.statSync(producedPath);
          const mimeType = mime.lookup(clientFileName) || "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": mimeType,
            "Content-Length": stat.size,
            "Content-Disposition": `attachment; filename="${clientFileName}"`,
          });

          const stream = fs.createReadStream(producedPath);
          stream.pipe(res);

          stream.on("error", async (err) => {
            console.error("❌ Stream error:", err.message);
            res.destroy();
            await safeCleanup(producedPath);
          });

          res.on("finish", async () => {
            await safeCleanup(producedPath);
          });
        } catch (err) {
          console.error("❌ Streaming setup failed:", err);
          res.status(500).json({ error: "Failed to stream output file." });
        }

      } catch (e) {
        console.error("Processing error:", e && e.message ? e.message : e);
        // Cleanup input file now
        try { await cleanupAll(); } catch (_) {}
        if (!res.headersSent) {
          const message = (e && e.message) ? e.message : "Processing failed";
          console.error("❌ Conversion failed:", message);
          await safeCleanup(producedPath);
          return res.status(500).json({ error: message });
        }
      }
    })();
  });
});

module.exports = router;
    
