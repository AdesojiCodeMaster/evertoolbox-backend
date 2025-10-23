// universal-filetool.js
// CommonJS Express router for EverToolbox front-end.
// Exports a router that is mounted at /api/tools/file by server.js
//
// Required system tools (installed in your Dockerfile):
//  - ffmpeg
//  - imagemagick (convert or magick)
//  - ghostscript (gs)
//  - libreoffice
//  - poppler-utils (pdftoppm / pdftotext) recommended
//  - pandoc (optional but recommended for pdf->docx fallback)
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

// Quick check whether a command exists in PATH
async function hasCmd(name) {
  try {
    await runCmd(`which ${name}`);
    return true;
  } catch {
    return false;
  }
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

// -------------------------
// Filename / extension helpers
// -------------------------
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

// Universal fixer to ensure outputs always get the requested extension
function fixOutputExtension(filename, targetFormat) {
  const clean = filename.replace(/\.[^/.]+$/, ""); // remove old extension
  const format = (targetFormat || "").toLowerCase();

  // --- AUDIO ---
  const audioExt = ["wav", "mp3", "opus", "ogg", "m4a", "webm"];
  if (audioExt.includes(format)) return `${clean}.${format}`;

  // --- VIDEO ---
  const videoExt = ["mp4", "webm", "avi", "mov", "mkv"];
  if (videoExt.includes(format)) return `${clean}.${format}`;

  // --- IMAGE ---
  const imageExt = ["png", "jpg", "jpeg", "gif", "bmp", "tiff", "webp"];
  if (imageExt.includes(format)) return `${clean}.${format}`;

  // --- DOCUMENTS / PDF ---
  const docExt = ["pdf", "docx", "txt", "md", "rtf", "html", "odt", "xlsx", "pptx"];
  if (docExt.includes(format)) return `${clean}.${format}`;

  // Default fallback
  return `${clean}.${format}`;
}

// ✅ Helper: Ensure the output file has the correct extension before sending
async function ensureProperExtension(filePath, targetExt) {
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  const correctExt = (targetExt || "").replace('.', '').toLowerCase();

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

// Mapping & helpers
const imageExts = new Set(["jpg", "jpeg", "png", "webp", "gif", "tiff", "bmp", "pdf"]);
const audioExts = new Set(['mp3', 'wav', 'm4a', 'ogg', 'opus', 'webm']);
const videoExts = new Set(["mp4", "avi", "mov", "webm", "mkv"]);
const docExts = new Set(["pdf", "docx", "txt", "md", "html"]);

// -------------------------
// Conversion functions
// -------------------------

// Convert PDF first page -> image (png/jpeg/webp/etc).
// Tries pdftoppm (fast & safe). If missing, falls back to ImageMagick.
async function convertPdfToImage(inputPath, outPath, targetExt, magickCmd) {
  targetExt = targetExt.replace('.', '').toLowerCase();
  const outputBase = outPath.replace(/\.[^.]+$/, '');
  const correctOutPath = `${outputBase}.${targetExt}`;

  // If pdftoppm available, prefer it for png/jpeg
  if (await hasCmd('pdftoppm') && ['png', 'jpg', 'jpeg'].includes(targetExt)) {
    const format = targetExt === 'png' ? 'png' : 'jpeg';
    const cmd = `pdftoppm -f 1 -singlefile -${format} "${inputPath}" "${outputBase}"`;
    await runCmd(cmd);
    // pdftoppm writes outputBase.<format>
    if (fs.existsSync(correctOutPath)) return correctOutPath;
    // fallback: search for produced file that starts with outputBase and ends with targetExt
    const tryFiles = fs.readdirSync(path.dirname(outputBase)).map(f => path.join(path.dirname(outputBase), f));
    for (const f of tryFiles) {
      if (f.startsWith(outputBase) && f.endsWith(`.${targetExt}`)) return f;
    }
    // If not found, fall through to ImageMagick fallback
  }

  // Fallback to ImageMagick (magick/convert) for other formats or if pdftoppm missing
  magickCmd = magickCmd || await findMagickCmd();
  const cmd = `${magickCmd} -density 150 "${inputPath}[0]" -background white -alpha remove -alpha off -flatten -quality 90 "${correctOutPath}"`;
  await runCmd(cmd);
  return correctOutPath;
}

async function convertImageToPdf(inputPath, outPath, magickCmd) {
  const correctOutPath = outPath.endsWith(".pdf") ? outPath : `${outPath}.pdf`;
  const cmd = `${magickCmd} "${inputPath}" -alpha off -compress jpeg "${correctOutPath}"`;
  await runCmd(cmd);
  return correctOutPath;
}

async function convertImage(inputPath, outPath, targetExt, magickCmd) {
  targetExt = targetExt.replace('.', '').toLowerCase();
  const inputExt = extOfFilename(inputPath).toLowerCase();
  if (inputExt === 'pdf') {
    return await convertPdfToImage(inputPath, outPath, targetExt, magickCmd);
  }

  const correctOutPath = outPath.endsWith(`.${targetExt}`) ? outPath : `${outPath}.${targetExt}`;

  const quality = (['webp'].includes(targetExt)) ? 75 : 90;
  let cmd = `${magickCmd} "${inputPath}" -strip -quality ${quality} "${correctOutPath}"`;

  if (inputExt === 'gif' && ['png', 'jpg', 'jpeg'].includes(targetExt)) {
    cmd = `${magickCmd} "${inputPath}[0]" -strip -quality ${quality} "${correctOutPath}"`;
  }

  await runCmd(cmd);
  // Ensure extension if ImageMagick wrote a different name
  return await ensureProperExtension(correctOutPath, targetExt);
}

async function compressImage(inputPath, outPath, targetExt, magickCmd) {
  const outExt = targetExt || extOfFilename(outPath);
  const quality = outExt === "webp" ? 75 : 72;
  const correctOutPath = outPath.endsWith(`.${outExt}`) ? outPath : `${outPath}.${outExt}`;
  const cmd = `${magickCmd} "${inputPath}" -strip -quality ${quality} "${correctOutPath}"`;
  await runCmd(cmd);
  return correctOutPath;
}

async function convertAudio(inputPath, outPath, targetExt) {
  targetExt = targetExt.replace('.', '').toLowerCase();
  // Ensure the desired extension is present in the path
  let correctOutPath = fixOutputExtension(outPath, targetExt);

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
      // Force a native Opus container and ensure filename uses .opus
      // -f opus encourages ffmpeg to produce an opus file instead of choosing ogg
      cmd = `ffmpeg -y -i "${inputPath}" -c:a libopus -b:a 96k -f opus "${correctOutPath}"`;
      break;
    case 'm4a':
      cmd = `ffmpeg -y -i "${inputPath}" -c:a aac -b:a 128k "${correctOutPath}"`;
      break;
    case 'webm':
      // Audio-only webm using Opus — faster than full video webm transcode
      // -vn disables video; this is handy when converting audio files into webm audio
      cmd = `ffmpeg -y -i "${inputPath}" -vn -c:a libopus -b:a 96k "${correctOutPath}"`;
      break;
    default:
      throw new Error(`Unsupported target audio format: ${targetExt}`);
  }

  await runCmd(cmd);

  // If ffmpeg wrote a file with a different extension/container, try to find and rename it
  if (!fs.existsSync(correctOutPath)) {
    const base = correctOutPath.replace(/\.[^/.]+$/, "");
    const candidates = fs.readdirSync(path.dirname(correctOutPath)).map(f => path.join(path.dirname(correctOutPath), f));
    for (const c of candidates) {
      if (c.startsWith(base) && audioExts.has(extOfFilename(c))) {
        try {
          await fsp.rename(c, correctOutPath);
        } catch (err) {
          // ignore rename errors
        }
        break;
      }
    }
  }

  // Final ensure
  return await ensureProperExtension(correctOutPath, targetExt);
}

async function compressAudio(inputPath, outPath) {
  const ext = extOfFilename(outPath) || 'mp3';
  const correctOutPath = outPath.endsWith(`.${ext}`) ? outPath : `${outPath}.${ext}`;
  const targetBitrate = "128k";
  const cmd = `ffmpeg -y -i "${inputPath}" -codec:a libmp3lame -b:a ${targetBitrate} "${correctOutPath}"`;
  await runCmd(cmd);
  return correctOutPath;
}

async function convertVideo(inputPath, outPath, targetExt) {
  targetExt = targetExt.replace('.', '').toLowerCase();
  const correctOutPath = fixOutputExtension(outPath, targetExt);

  let cmd;
  if (targetExt === 'webm') {
    // Use VP8 (libvpx) for speed on CPU-only hosts with realtime settings
    // cpu-used 8 trades compression for speed; row-mt 1 enables multithreading
    cmd = `ffmpeg -y -threads 0 -i "${inputPath}" -c:v libvpx -b:v 1M -cpu-used 8 -deadline realtime -row-mt 1 -c:a libopus -b:a 96k "${correctOutPath}"`;
  } else if (['mp4', 'mov', 'm4v', 'avi', 'mkv'].includes(targetExt)) {
    // H.264 for broad compatibility; ultrafast preset for speed
    cmd = `ffmpeg -y -threads 0 -i "${inputPath}" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 128k "${correctOutPath}"`;
  } else {
    // fallback: copy streams where possible (very fast)
    cmd = `ffmpeg -y -threads 0 -i "${inputPath}" -c copy "${correctOutPath}"`;
  }

  await runCmd(cmd);

  // ensure proper extension if ffmpeg produced a different file name
  return await ensureProperExtension(correctOutPath, targetExt);
}

async function compressVideo(inputPath, outPath) {
  const correctOutPath = outPath; // caller should provide extension
  const cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset medium -crf 28 -c:a aac -b:a 96k "${correctOutPath}"`;
  await runCmd(cmd);
  return correctOutPath;
}

async function convertDocument(inputPath, outPath, targetExt, tempDir) {
  const inExt = extOfFilename(inputPath);
  targetExt = targetExt.replace('.', '').toLowerCase();

  // DOCX/HTML/TXT -> PDF via LibreOffice
  if (targetExt === "pdf" && (inExt !== "pdf")) {
    const cmd = `libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to pdf "${inputPath}" --outdir "${tempDir}"`;
    await runCmd(cmd);
    const generated = path.join(tempDir, `${path.parse(inputPath).name}.pdf`);
    if (!fs.existsSync(generated)) throw new Error("LibreOffice did not produce PDF");
    await fsp.rename(generated, outPath);
    return outPath;
  }

  // PDF -> DOCX or HTML via LibreOffice (preferred), optimized flags for speed
  if (inExt === "pdf" && (targetExt === "docx" || targetExt === "html")) {
    const format = targetExt === "docx" ? "docx" : "html";
    try {
      const cmd = `libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to ${format} "${inputPath}" --outdir "${tempDir}"`;
      await runCmd(cmd);
      const gen = path.join(tempDir, `${path.parse(inputPath).name}.${format}`);
      if (fs.existsSync(gen)) {
        await fsp.rename(gen, outPath);
        return outPath;
      }
      // if libreoffice didn't produce a file, fallthrough to fallback
    } catch (err) {
      // continue to fallback
    }

    // Fallback: try pdftotext + pandoc to create docx/html (if tools available)
    if (await hasCmd('pdftotext') && await hasCmd('pandoc')) {
      const txtTemp = path.join(tempDir, `${path.parse(inputPath).name}.txt`);
      await runCmd(`pdftotext "${inputPath}" "${txtTemp}"`);
      if (!fs.existsSync(txtTemp)) throw new Error("pdftotext failed in fallback.");
      if (targetExt === 'docx') {
        await runCmd(`pandoc "${txtTemp}" -o "${outPath}"`);
        if (!fs.existsSync(outPath)) throw new Error("pandoc fallback to docx failed");
        try { await fsp.unlink(txtTemp); } catch {}
        return outPath;
      } else if (targetExt === 'html') {
        await runCmd(`pandoc "${txtTemp}" -o "${outPath}"`);
        if (!fs.existsSync(outPath)) throw new Error("pandoc fallback to html failed");
        try { await fsp.unlink(txtTemp); } catch {}
        return outPath;
      }
    }

    throw new Error(`Conversion to ${format} failed`);
  }

  // PDF -> TXT / MD using pdftotext (fast & reliable)
  if (inExt === "pdf" && (targetExt === "txt" || targetExt === "md")) {
    if (!await hasCmd('pdftotext')) {
      throw new Error(`Document conversion pdf -> ${targetExt} not supported on this server (pdftotext missing)`);
    }
    const txtTemp = path.join(tempDir, `${path.parse(inputPath).name}.txt`);
    await runCmd(`pdftotext "${inputPath}" "${txtTemp}"`);
    if (!fs.existsSync(txtTemp)) throw new Error("pdftotext failed");
    if (targetExt === "txt") {
      await fsp.rename(txtTemp, outPath);
      return outPath;
    } else {
      if (await hasCmd('pandoc')) {
        await runCmd(`pandoc "${txtTemp}" -o "${outPath}"`);
        if (!fs.existsSync(outPath)) {
          await fsp.rename(txtTemp, outPath);
        } else {
          try { await fsp.unlink(txtTemp); } catch {}
        }
        return outPath;
      } else {
        await fsp.rename(txtTemp, outPath);
        return outPath;
      }
    }
  }

  // TXT/MD/HTML -> PDF via LibreOffice / pandoc fallback
  if ((inExt === "txt" || inExt === "md" || inExt === "html") && targetExt === "pdf") {
    try {
      const cmd = `libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to pdf "${inputPath}" --outdir "${tempDir}"`;
      await runCmd(cmd);
      const generated = path.join(tempDir, `${path.parse(inputPath).name}.pdf`);
      if (!fs.existsSync(generated)) throw new Error("LibreOffice conversion failed");
      await fsp.rename(generated, outPath);
      return outPath;
    } catch (e) {
      if (await hasCmd('pandoc')) {
        await runCmd(`pandoc "${inputPath}" -o "${outPath}"`);
        if (!fs.existsSync(outPath)) throw new Error("pandoc conversion failed");
        return outPath;
      }
      throw new Error("Document conversion failed (libreoffice/pandoc unavailable)");
    }
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
      await safeCleanup(tempInput);
      return res.status(400).json({ error: "Invalid mode. Must be 'convert' or 'compress'." });
    }

    // If compress mode, ignore any provided targetFormat (frontend disables it). We'll compress in-place format.
    const magickCmd = await findMagickCmd();

    // If convert mode, targetFormat required
    if (mode === "convert" && !providedTarget) {
      await safeCleanup(tempInput);
      return res.status(400).json({ error: "Target format is required for conversion." });
    }

    // Prevent same-format conversion
    if (mode === "convert" && providedTarget && isSameExt(inputExt, providedTarget)) {
      await safeCleanup(tempInput);
      return res.status(400).json({ error: "Selected target format is the same as uploaded file format. Please choose a different target format." });
    }

    // Determine category
    const targetExt = mode === "convert" ? providedTarget : inputExt; // compress to same ext
    const lowerInputExt = inputExt.toLowerCase();

    // Accept pdf both as doc and image source — so if input or target is pdf we handle accordingly
    if (!imageExts) throw new Error("imageExts not defined!");
    
    const isImageCategory = imageExts.has(lowerInputExt) || imageExts.has(targetExt);
    const isAudioCategory = audioExts.has(lowerInputExt) || audioExts.has(targetExt);
    const isVideoCategory = videoExts.has(lowerInputExt) || videoExts.has(targetExt);
    const isDocCategory = docExts.has(lowerInputExt) || docExts.has(targetExt);

    // Prepare output file path and enforce correct extension
    const outName = safeOutputName(originalName, targetExt);
    const outPathRaw = path.join(os.tmpdir(), `${Date.now()}-${uuidv4()}-${outName}`);
    const outPath = fixOutputExtension(outPathRaw, targetExt);

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
            producedPath = await convertImage(tempInput, outPath, targetExt, magickCmd);
          } else {
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
            if (targetExt === "pdf" && !["pdf"].includes(lowerInputExt)) {
              await convertDocument(tempInput, outPath, "pdf", tempDir);
              producedPath = outPath;
            } else if (lowerInputExt === "pdf" && imageExts.has(targetExt) && targetExt !== "pdf") {
              // pdf -> image (first page)
              producedPath = await convertPdfToImage(tempInput, outPath, targetExt, magickCmd);
            } else if (imageExts.has(lowerInputExt) && targetExt === "pdf") {
              producedPath = await convertImageToPdf(tempInput, outPath, magickCmd);
            } else {
              // generic document conversion (libreoffice / pandoc fallback)
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

        // Verify and fix missing/wrong extension before sending
        producedPath = await ensureProperExtension(producedPath, targetExt);

        const clientFileName = safeOutputName(originalName, extOfFilename(producedPath) || targetExt);

        // Stream the file and clean up safely afterward
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
