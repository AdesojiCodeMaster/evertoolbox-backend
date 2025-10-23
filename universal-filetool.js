// universal-filetool.js
// CommonJS Express router for EverToolbox front-end.
// Exports a router that is mounted at /api/tools/file by server.js
//
// Required system tools (installed in your Dockerfile):
//  - ffmpeg
//  - imagemagick (convert or magick)
//  - ghostscript (gs)
//  - libreoffice
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
  const correctExt = targetExt.replace('.', '').toLowerCase();

  // If extension is missing or wrong, rename it
  if (!ext || ext !== correctExt) {
    const fixedPath = `${filePath}.${correctExt}`;
    try {
      await fsp.rename(filePath, fixedPath);
      console.log(`🔧 Fixed file extension: ${fixedPath}`);
      return fixedPath;
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
async function convertPdfToImage(inputPath, outPath, targetExt) {
  targetExt = targetExt.replace('.', '').toLowerCase();
  const outputBase = outPath.replace(/\.[^.]+$/, '');
  const correctOutPath = `${outputBase}.${targetExt}`;

  let cmd;
  // prefer pdftoppm for png/jpeg
  if (['png', 'jpg', 'jpeg'].includes(targetExt)) {
    const format = targetExt === 'png' ? 'png' : 'jpeg';
    cmd = `pdftoppm -f 1 -singlefile -${format} "${inputPath}" "${outputBase}"`;
  } else {
    // fallback to ImageMagick for other formats (webp, bmp, etc.)
    cmd = `convert -density 150 "${inputPath}[0]" -background white -alpha remove -alpha off -flatten -quality 90 "${correctOutPath}"`;
  }

  await runCmd(cmd);
  // pdftoppm writes outputBase.<format> (e.g. /tmp/x.png) — return path
  // ensure we return the file that exists (some commands produce slightly different names)
  if (fs.existsSync(correctOutPath)) return correctOutPath;
  // fallback: if pdftoppm used 'outputBase.ppm' or 'outputBase-1.png' — try to find the file:
  const tryFiles = fs.readdirSync(path.dirname(outputBase)).map(f => path.join(path.dirname(outputBase), f));
  for (const f of tryFiles) {
    if (f.startsWith(outputBase) && f.endsWith(`.${targetExt}`)) return f;
  }
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
  targetExt = targetExt.replace('.', '').toLowerCase();
  // If the input is a PDF, delegate to convertPdfToImage (first page)
  const inputExt = extOfFilename(inputPath).toLowerCase();
  if (inputExt === 'pdf') {
    return await convertPdfToImage(inputPath, outPath, targetExt);
  }

  // Ensure output path ends with the requested extension
  const correctOutPath = outPath.endsWith(`.${targetExt}`) ? outPath : `${outPath}.${targetExt}`;

  // Basic ImageMagick conversions, safe defaults
  // -strip to remove metadata, -quality for lossy formats
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
  targetExt = targetExt.replace('.', '').toLowerCase();
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
      // produce an .opus file (Ogg Opus or raw Opus stream depending on container)
      // using .opus extension should be fine; ffmpeg will choose a suitable container.
      cmd = `ffmpeg -y -i "${inputPath}" -c:a libopus -b:a 96k "${correctOutPath}"`;
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
  // Ensure .mp3 extension exists (outPath should already have extension by caller)
  const ext = extOfFilename(outPath) || 'mp3';
  const correctOutPath = outPath.endsWith(`.${ext}`) ? outPath : `${outPath}.${ext}`;
  const targetBitrate = "128k";
  const cmd = `ffmpeg -y -i "${inputPath}" -codec:a libmp3lame -b:a ${targetBitrate} "${correctOutPath}"`;
  await runCmd(cmd);
  return correctOutPath;
}


async function convertVideo(inputPath, outPath, targetExt) {
  // fast, pragmatic conversion settings for Render-like servers
  targetExt = targetExt.replace('.', '').toLowerCase();

  // ensure outPath has extension
  const correctOutPath = outPath.endsWith(`.${targetExt}`) ? outPath : `${outPath}.${targetExt}`;

  let cmd;

  if (targetExt === 'webm') {
    // Use VP8 (libvpx) for speed + libopus audio
    cmd = `ffmpeg -y -threads 0 -i "${inputPath}" -c:v libvpx -b:v 1M -cpu-used 8 -deadline realtime -c:a libopus -b:a 96k "${correctOutPath}"`;
  } else if (['mp4', 'mov', 'm4v', 'avi', 'mkv'].includes(targetExt)) {
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
  // For docx/html -> pdf use libreoffice
  const inExt = extOfFilename(inputPath);
  if (targetExt === "pdf") {
    const cmd = `libreoffice --headless --convert-to pdf "${inputPath}" --outdir "${tempDir}"`;
    await runCmd(cmd);
    const generated = path.join(tempDir, `${path.parse(inputPath).name}.pdf`);
    if (!fs.existsSync(generated)) throw new Error("LibreOffice did not produce PDF");
    await fsp.rename(generated, outPath);
    return outPath;
  }

  if (inExt === "pdf" && (targetExt === "docx" || targetExt === "html")) {
    const format = targetExt === "docx" ? "docx" : "html";
    const cmd = `libreoffice --headless --convert-to ${format} "${inputPath}" --outdir "${tempDir}"`;
    await runCmd(cmd);
    const gen = path.join(tempDir, `${path.parse(inputPath).name}.${format}`);
    if (!fs.existsSync(gen)) throw new Error(`Conversion to ${format} failed`);
    await fsp.rename(gen, outPath);
    return outPath;
  }

  if ((inExt === "txt" || inExt === "md" || inExt === "html") && targetExt === "pdf") {
    const cmd = `libreoffice --headless --convert-to pdf "${inputPath}" --outdir "${tempDir}"`;
    await runCmd(cmd);
    const generated = path.join(tempDir, `${path.parse(inputPath).name}.pdf`);
    if (!fs.existsSync(generated)) throw new Error("LibreOffice conversion failed");
    await fsp.rename(generated, outPath);
    return outPath;
  }

  throw new Error(`Document conversion ${inExt} -> ${targetExt} not supported on this server`);
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

    // Prepare output file path
    const outName = safeOutputName(originalName, targetExt);
    const outPath = path.join(os.tmpdir(), `${Date.now()}-${uuidv4()}-${outName}`);

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
              // Try generic document conversion via libreoffice (may support docx->html etc)
              await convertDocument(tempInput, outPath, targetExt, tempDir);
              producedPath = outPath;
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
