// universal-filetool.js — Option A Hybrid (production-ready)
// Hybrid temp strategy: try /dev/shm first (fast), fallback to /tmp (stable).
// Requirements: ffmpeg, libreoffice, poppler-utils (pdftoppm/pdftotext), ghostscript (gs),
// imagemagick (magick or convert), pandoc (optional).
// Keeps AAC logic unchanged.

const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");
const mime = require("mime-types");

const pipe = promisify(pipeline);
const router = express.Router();

const SHM = "/dev/shm";
const TMP = process.env.TMPDIR || os.tmpdir();
const TRY_DIRS = (fs.existsSync(SHM) ? [SHM, TMP] : [TMP]); // hybrid: try shm then tmp
const FFMPEG_THREADS = process.env.FFMPEG_THREADS || "2";
const STABLE_CHECK_MS = 200;
const STABLE_CHECK_ROUNDS = 3;
const STABLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

// ---------------- Multer ----------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}-${file.originalname.replace(/\s+/g, "_")}`)
  }),
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB
}).single("file");

// ---------------- Exec wrapper ----------------
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
  try { await runCmd(`which ${name}`); return true; } catch { return false; }
}
async function findMagickCmd() {
  try { await runCmd("magick -version"); return "magick"; }
  catch { try { await runCmd("convert -version"); return "convert"; } catch { return null; } }
}

// ---------------- Utilities ----------------
function extOfFilename(name) { return (path.extname(name || "").replace(".", "") || "").toLowerCase(); }
function sanitizeFilename(name) { return path.basename(name).replace(/[^a-zA-Z0-9._\- ]/g, "_"); }
function safeOutputBase(originalName) { return `${Date.now()}-${uuidv4()}-${path.parse(originalName).name.replace(/\s+/g, "_")}`; }
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
    const newPath = path.join(path.dirname(filePath), `${path.parse(filePath).name}.${clean}`);
    if (newPath === filePath) return filePath;
    if (fs.existsSync(filePath)) {
      await fsp.rename(filePath, newPath);
      console.log("🔧 Fixed extension:", newPath);
      return newPath;
    }
  } catch (e) {
    console.warn("ensureProperExtension error:", e && e.message);
  }
  return filePath;
}
async function safeCleanup(filePath) {
  try {
    if (!filePath) return;
    if (fs.existsSync(filePath)) {
      await fsp.unlink(filePath);
      console.log("🧹 Temp deleted:", filePath);
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("cleanup failed:", e && e.message);
  }
}

async function waitForStableFileSize(filePath, timeoutMs = STABLE_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(filePath)) { await new Promise(r => setTimeout(r, STABLE_CHECK_MS)); continue; }
    let stable = true;
    let prev = fs.statSync(filePath).size;
    for (let r = 0; r < STABLE_CHECK_ROUNDS; ++r) {
      await new Promise(rp => setTimeout(rp, STABLE_CHECK_MS));
      const now = fs.existsSync(filePath) ? fs.statSync(filePath).size : -1;
      if (now !== prev) { stable = false; prev = now; break; }
    }
    if (stable && prev > 0) return true;
  }
  return false;
}

function mapMimeByExt(ext) {
  const e = (ext || "").replace(/^\./, "").toLowerCase();
  const map = {
    wav: "audio/wav", mp3: "audio/mpeg", opus: "audio/opus", ogg: "audio/ogg", m4a: "audio/mp4",
    aac: "audio/aac", webm: "video/webm", mp4: "video/mp4", avi: "video/x-msvideo", mov: "video/quicktime",
    mkv: "video/x-matroska", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    gif: "image/gif", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", html: "text/html",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  };
  return map[e] || mime.lookup(e) || "application/octet-stream";
}

const imageExts = new Set(["jpg","jpeg","png","webp","gif","tiff","bmp"]);
const audioExts = new Set(["mp3","wav","m4a","ogg","opus","flac","aac","webm"]);
const videoExts = new Set(["mp4","avi","mov","webm","mkv","m4v"]);
const officeExts = new Set(["doc","docx","ppt","pptx","xls","xlsx","odt","ods","odp"]);
const docExts = new Set(["pdf","txt","md","html"]);

// ---------------- Prewarm (non-blocking) ----------------
(async function prewarm() {
  try {
    console.log("🔥 Prewarming tools...");
    await Promise.allSettled([
      runCmd("ffmpeg -version"),
      runCmd("libreoffice --headless --version").catch(()=>{}),
      runCmd("pdftoppm -v").catch(()=>{}),
      runCmd("pdftotext -v").catch(()=>{}),
      runCmd("magick -version").catch(()=>runCmd("convert -version").catch(()=>{})),
      runCmd("gs --version").catch(()=>{})
    ]);
    console.log("🔥 Prewarm done");
  } catch (e) { console.warn("Prewarm notice:", e && e.message); }
})();

// ---------------- Helper: flatten image to white ----------------
async function flattenImageWhite(input, out) {
  const magick = await findMagickCmd();
  if (magick) {
    const cmd = `${magick} "${input}" -background white -alpha remove -alpha off "${out}"`;
    await runCmd(cmd);
  } else {
    await fsp.copyFile(input, out);
  }
}

// ---------------- Core: attempt operation in try dirs (hybrid) ----------------
async function tryInDirs(fnFactory) {
  let lastErr = null;
  for (const base of TRY_DIRS) {
    const workDir = path.join(base, `evertoolbox-${Date.now()}-${uuidv4()}`);
    try {
      await fsp.mkdir(workDir, { recursive: true });
      try {
        const result = await fnFactory(workDir);
        return { result, workDir };
      } catch (err) {
        lastErr = err;
        // clean workDir and continue to next
        try { await fsp.rmdir(workDir, { recursive: true }); } catch {}
        continue;
      }
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error("All temp dirs failed");
}

// ---------------- Audio conversion ----------------
async function convertAudioAtTmp(input, outBase, targetExt, tmpDir) {
  if (!fs.existsSync(input)) throw new Error("Input missing");
  const ext = (targetExt || path.extname(outBase)).toString().replace(/^\./, "").toLowerCase();
  if (!ext) throw new Error("No target audio extension specified");

  let out = path.join(tmpDir, `${path.parse(outBase).name}.${ext}`);
  // special-handling for types that need explicit container naming
  switch (ext) {
    case "wav":
      await runCmd(`ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -acodec pcm_s16le -ar 44100 "${out}"`);
      break;
    case "mp3":
      await runCmd(`ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -codec:a libmp3lame -qscale:a 2 "${out}"`);
      break;
    case "ogg":
      await runCmd(`ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:a libvorbis -q:a 4 "${out}"`);
      break;
    case "opus":
      out = path.join(tmpDir, `${path.parse(outBase).name}.opus`);
      await runCmd(`ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a libopus -b:a 96k -vn -f opus "${out}"`);
      break;
    case "aac":
      out = path.join(tmpDir, `${path.parse(outBase).name}.aac`);
      await runCmd(`ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a aac -b:a 128k -f adts "${out}"`);
      break;
    case "m4a":
      out = path.join(tmpDir, `${path.parse(outBase).name}.m4a`);
      await runCmd(`ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a aac -b:a 128k "${out}"`);
      break;
    case "flac":
      out = path.join(tmpDir, `${path.parse(outBase).name}.flac`);
      await runCmd(`ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a flac "${out}"`);
      break;
    case "webm":
      out = path.join(tmpDir, `${path.parse(outBase).name}.webm`);
      await runCmd(`ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -vn -c:a libopus -b:a 96k -f webm "${out}"`);
      break;
    default:
      throw new Error(`Unsupported target audio format: ${ext}`);
  }

  if (!fs.existsSync(out)) throw new Error("Audio conversion failed: output missing");
  if (!(await waitForStableFileSize(out))) throw new Error("Audio conversion failed: unstable output");
  return out;
}

// ---------------- Video conversion ----------------
async function convertVideoAtTmp(input, outBase, targetExt, tmpDir) {
  if (!fs.existsSync(input)) throw new Error("Input missing");
  const ext = (targetExt || path.extname(outBase)).toString().replace(/^\./, "").toLowerCase();
  if (!ext) throw new Error("No target video extension specified");

  const out = path.join(tmpDir, `${path.parse(outBase).name}.${ext}`);

  if (ext === "webm") {
    // prefer VP9; fallback to VP8 if VP9 fails
    const vp9 = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libvpx-vp9 -b:v 1M -cpu-used 4 -row-mt 1 -c:a libopus -b:a 96k -f webm "${out}"`;
    try {
      await runCmd(vp9);
    } catch (e) {
      console.warn("VP9 failed, fallback to VP8:", e && e.message);
      const vp8 = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libvpx -b:v 1M -cpu-used 5 -row-mt 1 -c:a libopus -b:a 96k -f webm "${out}"`;
      await runCmd(vp8);
    }
  } else if (ext === "mkv") {
    await runCmd(`ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 96k "${out}"`);
  } else if (["mp4","mov","m4v","avi"].includes(ext)) {
    await runCmd(`ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libx264 -preset fast -crf 28 -c:a aac -b:a 128k "${out}"`);
  } else {
    // container-only copy
    await runCmd(`ffmpeg -y -i "${input}" -c copy "${out}"`);
  }

  if (!fs.existsSync(out)) throw new Error("Video conversion failed: output missing");
  if (!(await waitForStableFileSize(out))) throw new Error("Video conversion failed: unstable output");
  return await ensureProperExtension(out, ext);
}

// ---------------- Document conversion ----------------
async function convertDocumentAtTmp(input, outBase, targetExt, tmpDir) {
  if (!fs.existsSync(input)) throw new Error("Input missing");
  const inExt = extOfFilename(input) || extOfFilename(path.basename(input));
  const ext = (targetExt || path.extname(outBase)).toString().replace(/^\./, "").toLowerCase();
  const out = path.join(tmpDir, `${path.parse(outBase).name}.${ext}`);

  // PDF -> images (single page) via pdftoppm
  if (inExt === "pdf" && ["png","jpg","jpeg","webp"].includes(ext)) {
    const format = (ext === "jpg" || ext === "jpeg") ? "jpeg" : ext;
    const prefix = path.join(tmpDir, path.parse(outBase).name);
    const cmd = `pdftoppm -f 1 -singlefile -${format} "${input}" "${prefix}"`;
    await runCmd(cmd).catch(err => { throw new Error(`pdftoppm failed: ${err.message}`); });
    const produced = `${prefix}.${format}`;
    if (!fs.existsSync(produced)) {
      // try alternative names (pdftoppm sometimes produces -1)
      const alt = `${prefix}-1.${format}`;
      if (fs.existsSync(alt)) {
        await fsp.rename(alt, out);
        return out;
      }
      throw new Error("pdftoppm did not produce page image");
    }
    // flatten to white to avoid dark background issue
    await flattenImageWhite(produced, out);
    await safeCleanup(produced);
    if (!(await waitForStableFileSize(out))) throw new Error("PDF->image output unstable");
    return out;
  }

  // PDF -> text/md
  if (inExt === "pdf" && ["txt","md"].includes(ext)) {
    if (await hasCmd("pdftotext")) {
      const mid = path.join(tmpDir, `${path.parse(outBase).name}.txt`);
      await runCmd(`pdftotext "${input}" "${mid}"`).catch(err => { throw new Error(`pdftotext failed: ${err.message}`); });
      if (ext === "md" && await hasCmd("pandoc")) {
        await runCmd(`pandoc "${mid}" -o "${out}"`).catch(err => { throw new Error(`pandoc failed: ${err.message}`); });
        await safeCleanup(mid);
        return out;
      }
      await fsp.rename(mid, out);
      return out;
    } else throw new Error("pdftotext not available");
  }

  // PDF -> docx via pdftotext + pandoc (best-effort)
  if (inExt === "pdf" && ext === "docx") {
    if (await hasCmd("pdftotext") && await hasCmd("pandoc")) {
      const mid = path.join(tmpDir, `${path.parse(outBase).name}.txt`);
      await runCmd(`pdftotext "${input}" "${mid}"`);
      await runCmd(`pandoc "${mid}" -o "${out}"`);
      await safeCleanup(mid);
      if (!(await waitForStableFileSize(out))) throw new Error("PDF->docx unstable");
      return out;
    }
  }

  // LibreOffice fallback for office & pdf
  if (officeExts.has(inExt) || officeExts.has(ext) || inExt === "pdf") {
    const cmd = `libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to ${ext} "${input}" --outdir "${tmpDir}"`;
    await runCmd(cmd).catch(err => { throw new Error(`LibreOffice conversion failed: ${err.message}`); });
    const gen = path.join(tmpDir, `${path.parse(input).name}.${ext}`);
    if (!fs.existsSync(gen)) {
      // sometimes libreoffice may create different suffixes; try to find any file with same basename+ext
      const files = await fsp.readdir(tmpDir);
      const candidate = files.find(f => f.startsWith(path.parse(input).name) && f.endsWith(`.${ext}`));
      if (candidate) {
        await fsp.rename(path.join(tmpDir, candidate), out);
      } else {
        throw new Error(`LibreOffice failed to produce ${ext}`);
      }
    } else {
      await fsp.rename(gen, out);
    }
    // flatten images
    if (["png","jpg","jpeg","webp"].includes(ext)) await flattenImageWhite(out, out);
    if (!(await waitForStableFileSize(out))) throw new Error("LibreOffice output unstable");
    return out;
  }

  throw new Error(`Unsupported document conversion: ${inExt} -> ${ext}`);
}

// ---------------- Compression (heavy) ----------------
async function compressAtTmp(input, outBase, inputExt, tmpDir) {
  if (!fs.existsSync(input)) throw new Error("Input missing");
  inputExt = (inputExt || extOfFilename(input)).replace(/^\./, "").toLowerCase();
  const out = path.join(tmpDir, `${path.parse(outBase).name}.${inputExt}`);

  let cmd;
  if (inputExt === "pdf") {
    cmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${out}" "${input}"`;
    await runCmd(cmd);
  } else if (imageExts.has(inputExt)) {
    const magick = await findMagickCmd();
    if (["jpg","jpeg"].includes(inputExt)) {
      if (!magick) throw new Error("imagemagick required for image compression");
      cmd = `${magick} "${input}" -strip -sampling-factor 4:2:0 -quality 55 -interlace Plane -colorspace sRGB "${out}"`;
      await runCmd(cmd);
    } else if (inputExt === "png") {
      if (await hasCmd("pngquant")) {
        await runCmd(`pngquant --quality=50-80 --output "${out}" --force "${input}"`);
      } else if (magick) {
        await runCmd(`${magick} "${input}" -strip -quality 60 "${out}"`);
      } else throw new Error("png compression requires imagemagick or pngquant");
    } else {
      const m = magick;
      if (!m) throw new Error("imagemagick required for image compression");
      await runCmd(`${m} "${input}" -strip -quality 60 "${out}"`);
    }
  } else if (audioExts.has(inputExt)) {
    await runCmd(`ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -ac 2 -ar 44100 -b:a 96k "${out}"`);
  } else if (videoExts.has(inputExt)) {
    if (inputExt === "webm") {
      await runCmd(`ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libvpx -b:v 600k -cpu-used 5 -row-mt 1 -c:a libopus -b:a 64k -f webm "${out}"`);
    } else {
      await runCmd(`ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libx264 -preset veryfast -crf 35 -c:a aac -b:a 96k "${out}"`);
    }
  } else if (officeExts.has(inputExt) || docExts.has(inputExt)) {
    // convert to PDF then compress (best-effort)
    const tmpPdf = path.join(tmpDir, `${path.parse(outBase).name}.pdf`);
    try {
      if (docExts.has(inputExt) && await hasCmd("pandoc")) {
        await runCmd(`pandoc "${input}" -o "${tmpPdf}"`);
      } else {
        await runCmd(`libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to pdf "${input}" --outdir "${tmpDir}"`);
        // find produced pdf
        const gen = path.join(tmpDir, `${path.parse(input).name}.pdf`);
        if (fs.existsSync(gen)) await fsp.rename(gen, tmpPdf);
      }
      await runCmd(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${tmpPdf}" "${tmpPdf}"`);
    } catch (e) {
      throw new Error(`Document compression failed: ${e && e.message}`);
    }
    if (!fs.existsSync(tmpPdf)) throw new Error("Document compression failed");
    return tmpPdf;
  } else {
    throw new Error(`Compression not supported for .${inputExt}`);
  }

  if (!fs.existsSync(out)) throw new Error("Compression failed: output missing");
  if (!(await waitForStableFileSize(out))) throw new Error("Compression failed: unstable output");
  return out;
}

// ---------------- Route ----------------
router.post("/", (req, res) => {
  try { req.setTimeout(0); } catch (e) {}
  try { res.setTimeout(0); } catch (e) {}

  upload(req, res, async function (err) {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    const mode = (req.body.mode || "convert").toLowerCase(); // convert | compress
    const requestedTarget = (req.body.targetFormat || "").toString().replace(/^\./, "").toLowerCase();
    const inputPath = req.file.path;
    const originalName = sanitizeFilename(req.file.originalname);
    const inputExt = extOfFilename(originalName) || extOfFilename(inputPath);
    const outBaseName = safeOutputBase(originalName);
    let producedPath = null;
    let usedWorkDir = null;

    // guard: disallow same-format conversion when convert mode and explicit target provided
    if (mode === "convert" && requestedTarget && requestedTarget === inputExt) {
      await safeCleanup(inputPath);
      return res.status(400).json({ error: `Conversion disallowed: source and target formats are identical (.${inputExt})` });
    }

    try {
      if (mode === "compress") {
        // compress: attempt in hybrid dirs
        const { result, workDir } = await tryInDirs(async (workDir) => {
          const outPath = path.join(workDir, `${outBaseName}.${inputExt}`);
          return await compressAtTmp(inputPath, outBaseName, inputExt, workDir);
        });
        producedPath = result;
        usedWorkDir = workDir;
      } else {
        // convert mode: pick converter based on input/target types
        // prefer target if provided; else preserve type (normalization)
        const effectiveTarget = requestedTarget || inputExt;

        // choose converter type: audio if either input or target is audio; video if either is video; doc if pdf/office
        const isAudio = audioExts.has(inputExt) || audioExts.has(effectiveTarget);
        const isVideo = videoExts.has(inputExt) || videoExts.has(effectiveTarget);
        const isDoc = docExts.has(inputExt) || docExts.has(effectiveTarget) || officeExts.has(effectiveTarget);
        const isImage = imageExts.has(inputExt) || imageExts.has(effectiveTarget);

        if (isAudio && !isVideo && !isDoc && !isImage) {
          const { result, workDir } = await tryInDirs(async (workDir) => {
            return await convertAudioAtTmp(inputPath, outBaseName, effectiveTarget, workDir);
          });
          producedPath = result; usedWorkDir = workDir;
        } else if (isVideo && !isAudio && !isDoc) {
          const { result, workDir } = await tryInDirs(async (workDir) => {
            return await convertVideoAtTmp(inputPath, outBaseName, effectiveTarget, workDir);
          });
          producedPath = result; usedWorkDir = workDir;
        } else if (isDoc) {
          const { result, workDir } = await tryInDirs(async (workDir) => {
            return await convertDocumentAtTmp(inputPath, outBaseName, effectiveTarget, workDir);
          });
          producedPath = result; usedWorkDir = workDir;
        } else if (isImage) {
          const magick = await findMagickCmd();
          if (!magick) throw new Error("ImageMagick not available for image conversion");
          const { result, workDir } = await tryInDirs(async (workDir) => {
            const out = path.join(workDir, `${outBaseName}.${effectiveTarget || inputExt}`);
            const cmd = `${magick} "${inputPath}" "${out}"`;
            await runCmd(cmd);
            // flatten to white to avoid dark background
            if (["png","jpg","jpeg","webp"].includes(extOfFilename(out))) {
              const tmpFlat = path.join(workDir, `${outBaseName}.flat.${extOfFilename(out)}`);
              await flattenImageWhite(out, tmpFlat);
              await fsp.rename(tmpFlat, out).catch(()=>{});
            }
            if (!fs.existsSync(out)) throw new Error("Image convert failed");
            if (!(await waitForStableFileSize(out))) throw new Error("Image output unstable");
            return out;
          });
          producedPath = result; usedWorkDir = workDir;
        } else {
          throw new Error(`Unsupported file type: .${inputExt}`);
        }
      }

      if (!producedPath || !fs.existsSync(producedPath)) throw new Error("Output not produced.");
      if (!(await waitForStableFileSize(producedPath))) throw new Error("Produced file unstable or empty.");

      // ensure extension correctness
      const finalTarget = (mode === "compress") ? inputExt : (requestedTarget || extOfFilename(producedPath) || inputExt);
      producedPath = await ensureProperExtension(producedPath, finalTarget);

      const outExt = extOfFilename(producedPath);
      const fileName = `${path.parse(originalName).name.replace(/\s+/g, "_")}.${outExt}`;
      const mimeType = mapMimeByExt(outExt);
      const stat = fs.statSync(producedPath);

      // Stream via pipeline and wait for completion before cleanup
      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });

      const readStream = fs.createReadStream(producedPath);
      await pipe(readStream, res);

      // Cleanup after full send
      await safeCleanup(producedPath);
      await safeCleanup(inputPath);
      // remove work dir if created
      if (usedWorkDir) {
        try { await fsp.rmdir(usedWorkDir, { recursive: true }); } catch (e) {}
      }

    } catch (e) {
      console.error("❌ Conversion/Compression error:", e && (e.message || e));
      // attempt cleanup
      try { if (producedPath) await safeCleanup(producedPath); } catch (er) {}
      try { await safeCleanup(inputPath); } catch (er) {}
      // don't leak work dirs
      try { if (usedWorkDir) await fsp.rmdir(usedWorkDir, { recursive: true }); } catch (er) {}
      if (!res.headersSent) return res.status(500).json({ error: e.message || String(e) });
      try { res.end(); } catch {}
    }
  });
});

module.exports = router;
                                        
