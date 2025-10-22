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
async function convertImage(inputPath, outPath, targetExt, magickCmd) {
  // For PDF inputs: convert first page by default to image (use [0])
  const inExt = extOfFilename(inputPath);
  const isPdfSource = inExt === "pdf";
  const density = 150; // resolution for PDF->image
  const quality = 90;

  const src = isPdfSource ? `${inputPath}[0]` : inputPath;

  // Decide if target format needs white background (JPG, JPEG, BMP, WEBP, GIF)
  const needsWhiteBg = ["jpg", "jpeg", "bmp", "webp", "gif"].includes(targetExt.toLowerCase());
  const bgOption = needsWhiteBg
    ? "-background white -alpha remove -alpha off -flatten"
    : "";

  // Build full ImageMagick command
  // Example: magick input.pdf[0] -background white -alpha remove -alpha off -flatten -strip -quality 90 output.jpg
  const cmd = `${magickCmd} "${src}" ${bgOption} -strip -quality ${quality} "${outPath}"`;

  await runCmd(cmd);
  return outPath;
}


async function convertImageToPdf(inputPath, outPath, magickCmd) {
  // Convert image to PDF
  const cmd = `${magickCmd} "${inputPath}" -alpha off -compress jpeg "${outPath}"`;
  await runCmd(cmd);
  return outPath;
}

async function compressImage(inputPath, outPath, targetExt, magickCmd) {
  // Use reasonable quality reductions depending on format
  const outExt = targetExt || extOfFilename(outPath);
  const quality = outExt === "webp" ? 75 : 72;
  const cmd = `${magickCmd} "${inputPath}" -strip -quality ${quality} "${outPath}"`;
  await runCmd(cmd);
  return outPath;
}

async function convertAudio(inputPath, outPath, targetExt) {
  targetExt = targetExt.replace('.', '').toLowerCase();

  // Ensure correct extension
  const correctOutPath = outPath.endsWith(`.${targetExt}`)
    ? outPath
    : `${outPath}.${targetExt}`;

  let codec = 'libmp3lame';
  let extra = '';

  switch (targetExt) {
    case 'm4a':
      codec = 'aac'; // safe AAC codec inside .m4a container
      extra = '-b:a 192k';
      break;
    case 'wav':
      codec = 'pcm_s16le';
      break;
    case 'ogg':
      codec = 'libvorbis';
      extra = '-ar 44100 -ac 2 -b:a 128k';
      break;
    case 'opus':
      codec = 'libopus';
      extra = '-b:a 128k';
      break;
    case 'mp3':
    default:
      codec = 'libmp3lame';
      extra = '-b:a 192k';
      break;
  }

  const cmd = `ffmpeg -y -i "${inputPath}" -vn -acodec ${codec} ${extra} "${correctOutPath}"`;
  await runCmd(cmd);
  return correctOutPath;
}



async function compressAudio(inputPath, outPath) {
  // Re-encode with lower bitrate for smaller size
  const targetBitrate = "128k";
  const cmd = `ffmpeg -y -i "${inputPath}" -codec:a libmp3lame -b:a ${targetBitrate} "${outPath}"`;
  await runCmd(cmd);
  return outPath;
}

async function convertVideo(inputPath, outPath, targetExt) {
  targetExt = targetExt.replace('.', '').toLowerCase();

  let cmd;

  if (targetExt === 'webm') {
    // ✅ WebM must use VP9 + Opus
    cmd = `ffmpeg -y -i "${inputPath}" -c:v libvpx-vp9 -b:v 1M -c:a libopus "${outPath}"`;
  } else if (['mp4', 'mov', 'm4v'].includes(targetExt)) {
    // ✅ MP4/MOV/M4V use H.264 + AAC
    cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset ultrafast -c:v libvpx-vp9 -b:v 1M -cpu-used 4 -crf 23 -c:a aac -b:a 128k "${outPath}"`;
  } else if (['avi', 'mkv'].includes(targetExt)) {
    // ✅ Generic safe fallback for AVI/MKV
    cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -crf 23 -c:a aac "${outPath}"`;
  } else {
    // fallback: copy streams if possible
    cmd = `ffmpeg -y -i "${inputPath}" -c copy "${outPath}"`;
  }

  await runCmd(cmd);
  return outPath;
}



async function compressVideo(inputPath, outPath) {
  // Increase CRF to reduce size
  const cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset medium -crf 28 -c:a aac -b:a 96k "${outPath}"`;
  await runCmd(cmd);
  return outPath;
}

async function convertDocument(inputPath, outPath, targetExt, tempDir) {
  // For docx/html -> pdf use libreoffice
  const inExt = extOfFilename(inputPath);
  if (targetExt === "pdf") {
    // Use libreoffice to convert common doc formats to PDF
    // libreoffice will place output in the specified outdir
    const cmd = `libreoffice --headless --convert-to pdf "${inputPath}" --outdir "${tempDir}"`;
    await runCmd(cmd);
    const generated = path.join(tempDir, `${path.parse(inputPath).name}.pdf`);
    if (!fs.existsSync(generated)) throw new Error("LibreOffice did not produce PDF");
    // Move/generate to outPath name if needed
    await fsp.rename(generated, outPath);
    return outPath;
  }

  // For pdf -> docx/html etc: attempt using libreoffice too
  if (inExt === "pdf" && (targetExt === "docx" || targetExt === "html")) {
    const format = targetExt === "docx" ? "docx" : "html";
    const cmd = `libreoffice --headless --convert-to ${format} "${inputPath}" --outdir "${tempDir}"`;
    await runCmd(cmd);
    const gen = path.join(tempDir, `${path.parse(inputPath).name}.${format}`);
    if (!fs.existsSync(gen)) throw new Error(`Conversion to ${format} failed`);
    await fsp.rename(gen, outPath);
    return outPath;
  }

  // For txt/md -> pdf: libreoffice can convert html/md if HTML; md may not convert reliably
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
  // Use ghostscript to compress pdf
  // /ebook or /screen change compression level; /ebook is reasonable
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

    // Stream file to response and cleanup afterward
    function streamAndFinish(filePath, filenameForClient) {
      try {
        const stat = fs.statSync(filePath);
        const mimeType = mime.lookup(filenameForClient) || "application/octet-stream";
        res.setHeader("Content-Type", mimeType);
        res.setHeader("Content-Length", stat.size);
        res.setHeader("Content-Disposition", `attachment; filename="${filenameForClient}"`);
        const read = fs.createReadStream(filePath);
        read.pipe(res);

        // After response finishes, cleanup
        res.on("finish", async () => {
          try {
            await cleanupAll();
          } catch (e) {
            console.error("Cleanup error:", e);
          }
        });

        res.on("close", async () => {
          try { await cleanupAll(); } catch (e) { /* ignore */ }
        });
      } catch (e) {
        console.error("Streaming error:", e);
        cleanupAll();
        if (!res.headersSent) res.status(500).json({ error: "Failed to stream result." });
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
            await convertImage(tempInput, outPath, targetExt, magickCmd);
            producedPath = outPath;
          } else {
            // compress image (same format)
            await compressImage(tempInput, outPath, targetExt, magickCmd);
            producedPath = outPath;
          }
        } else if (isAudioCategory && !isVideoCategory && !isDocCategory) {
          // AUDIO FLOW
          if (mode === "convert") {
            await convertAudio(tempInput, outPath, targetExt);
            producedPath = outPath;
          } else {
            await compressAudio(tempInput, outPath);
            producedPath = outPath;
          }
        } else if (isVideoCategory && !isAudioCategory && !isDocCategory) {
          // VIDEO FLOW
          if (mode === "convert") {
            await convertVideo(tempInput, outPath, targetExt);
            producedPath = outPath;
          } else {
            await compressVideo(tempInput, outPath);
            producedPath = outPath;
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
              await convertImage(tempInput, outPath, targetExt, magickCmd);
              producedPath = outPath;
            } else if (imageExts.has(lowerInputExt) && targetExt === "pdf") {
              await convertImageToPdf(tempInput, outPath, magickCmd);
              producedPath = outPath;
            } else {
              // Try generic document conversion via libreoffice (may support docx->html etc)
              await convertDocument(tempInput, outPath, targetExt, tempDir);
              producedPath = outPath;
            }
          } else {
            // compress document -> if pdf, compress with ghostscript
            if (lowerInputExt === "pdf") {
              await compressPdf(tempInput, outPath);
              producedPath = outPath;
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
// ✅ Stream large files safely (prevents timeouts & memory issues)
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
          return res.status(500).json({ error: message });


  console.error("❌ Conversion failed:", err);
  await safeCleanup(producedPath);
  res.status(500).json({ error: err.message });
        }
      }
    })();
  });
});

module.exports = router;
