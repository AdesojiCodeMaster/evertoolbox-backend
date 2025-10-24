// universal-filetool.js (FINAL - fully integrated, naked downloads only)
// Requirements in runtime image: ffmpeg, libreoffice, poppler-utils (pdftoppm/pdftotext), ghostscript (gs),
// imagemagick (magick or convert), pandoc (optional). No zip fallback. Uses /dev/shm when present.

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

const TMP_DIR = process.env.TMPDIR || (fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir());
const FFMPEG_THREADS = String(process.env.FFMPEG_THREADS || "2");
const STABLE_CHECK_MS = 200;
const STABLE_CHECK_ROUNDS = 3;
const STABLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes for large conversions

// ---------------- Multer upload ----------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}-${file.originalname.replace(/\s+/g, "_")}`)
  }),
  limits: { fileSize: 1024 * 1024 * 1024 } // 1 GB
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
async function hasPdftocairo() {
  try { await runCmd("which pdftocairo"); return true; } catch { return false; }
}

// ---------------- Utilities ----------------
function extOfFilename(name) { return (path.extname(name || "").replace(".", "") || "").toLowerCase(); }
function sanitizeFilename(name) { return path.basename(name).replace(/[^a-zA-Z0-9._\- ]/g, "_"); }
function safeOutputBase(originalName) { return `${Date.now()}-${uuidv4()}-${path.parse(originalName).name.replace(/\s+/g, "_")}`; }
// preserve exact casing passed in targetExt (do not lowercase)
function fixOutputExtension(filename, targetExt) {
  const clean = (targetExt || "").toString().replace(/^\./, "");
  if (!clean) return filename;
  const dir = path.dirname(filename);
  const base = path.parse(filename).name;
  return path.join(dir, `${base}.${clean}`);
}
// ensureProperExtension preserves given targetExt casing (do not lowercase)
async function ensureProperExtension(filePath, targetExt) {
  try {
    if (!filePath) return filePath;
    const clean = (targetExt || "").toString().replace(/^\./, "");
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
    // suppress ENOENT and log others
    if (e && e.code !== "ENOENT") console.warn("cleanup failed:", e && e.message);
  }
}

// Wait until file exists and its size is stable for STABLE_CHECK_ROUNDS
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

// Treat webm as video (not audio) to avoid audio-only webm conversions
const imageExts = new Set(["jpg","jpeg","png","webp","gif","tiff","bmp"]);
const audioExts = new Set(["mp3","wav","m4a","ogg","opus","flac","aac"]); // removed webm here
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
  // support either 'magick' or 'convert'
  const magickCmd = await findMagickCmd();
  if (magickCmd) {
    const cmd = `${magickCmd} "${input}" -background white -alpha remove -alpha off "${out}"`;
    await runCmd(cmd);
  } else {
    await fsp.copyFile(input, out);
  }
}

// ---------------- Audio conversion ----------------
async function convertAudio(input, outPath, targetExt) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  const ext = (targetExt || path.extname(outPath)).toString().replace(/^\./, "").toLowerCase();
  if (!ext) throw new Error("No target audio extension specified");

  // prefer to preserve exact requested extension casing if provided in outPath
  let out = fixOutputExtension(outPath, targetExt || ext);
  if (!path.extname(out)) out = `${out}.${targetExt || ext}`;

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
      out = fixOutputExtension(out, targetExt || "opus");
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a libopus -b:a 96k -vn -f opus "${out}"`;
      break;
    case "aac":
      out = fixOutputExtension(out, targetExt || "aac");
      // raw ADTS AAC stream
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a aac -b:a 128k -f adts "${out}"`;
      break;
    case "m4a":
      out = fixOutputExtension(out, targetExt || "m4a");
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a aac -b:a 128k "${out}"`;
      break;
    case "flac":
      // ensure ffmpeg writes a file with extension; add safe flags
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a flac "${out}"`;
      break;
    case "webm":
      out = fixOutputExtension(out, targetExt || "webm");
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -vn -c:a libopus -b:a 96k -f webm "${out}"`;
      break;
    default:
      throw new Error(`Unsupported target audio format: ${ext}`);
  }

  console.log("🎬 ffmpeg (audio):", cmd);
  await runCmd(cmd).catch(err => { throw new Error(err.message); });

  // If ffmpeg wrote output without extension, ensure it has one
  if (!path.extname(out)) {
    const outWithExt = `${out}.${targetExt || ext}`;
    if (fs.existsSync(out)) {
      await fsp.rename(out, outWithExt);
      out = outWithExt;
    }
  }

  if (!fs.existsSync(out)) throw new Error("Audio conversion failed: output missing");
  if (!(await waitForStableFileSize(out))) throw new Error("Audio conversion failed: output unstable or empty");

  return await ensureProperExtension(out, targetExt || ext);
}

// ---------------- Video conversion ----------------
async function convertVideo(input, outPath, targetExt) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  const ext = (targetExt || path.extname(outPath)).toString().replace(/^\./, "").toLowerCase();
  if (!ext) throw new Error("No target video extension specified");

  let out = fixOutputExtension(outPath, targetExt || ext);
  if (!path.extname(out)) out = `${out}.${targetExt || ext}`;

  let cmd;

  if (ext === "webm") {
    // prefer VP8 for speed (faster than VP9) and keep audio+video
    const vp8cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libvpx -b:v 1M -cpu-used 5 -row-mt 1 -c:a libopus -b:a 96k -f webm "${out}"`;
    console.log("🎬 ffmpeg (video - try vp8 fast):", vp8cmd);
    try {
      await runCmd(vp8cmd);
    } catch (errVp8) {
      console.warn("VP8 quick path failed, falling back to VP9:", errVp8 && errVp8.message);
      const tryVp9 = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libvpx-vp9 -b:v 1M -cpu-used 4 -row-mt 1 -c:a libopus -b:a 96k -f webm "${out}"`;
      console.log("🎬 ffmpeg (video - try vp9):", tryVp9);
      try {
        await runCmd(tryVp9);
      } catch (errVp9) {
        console.warn("VP9 failed, falling back to copy container:", errVp9 && errVp9.message);
        const fallbackCopy = `ffmpeg -y -i "${input}" -c copy "${out}"`;
        console.log("🎬 ffmpeg (video - container copy):", fallbackCopy);
        await runCmd(fallbackCopy).catch(err => { throw new Error(err.message); });
      }
    }
  } else if (ext === "mkv") {
    cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 96k "${out}"`;
    console.log("🎬 ffmpeg (video):", cmd);
    await runCmd(cmd).catch(err => { throw new Error(err.message); });
  } else if (["mp4","mov","m4v","avi"].includes(ext)) {
    // use faster preset for speed; keep reasonable quality
    cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 128k "${out}"`;
    console.log("🎬 ffmpeg (video):", cmd);
    await runCmd(cmd).catch(err => { throw new Error(err.message); });
  } else {
    // container-only copy for unknown containers
    cmd = `ffmpeg -y -i "${input}" -c copy "${out}"`;
    console.log("🎬 ffmpeg (container copy):", cmd);
    await runCmd(cmd).catch(err => { throw new Error(err.message); });
  }

  if (!fs.existsSync(out)) throw new Error("Video conversion failed: output missing");
  if (!(await waitForStableFileSize(out))) throw new Error("Video conversion failed: output unstable or empty");

  return await ensureProperExtension(out, targetExt || ext);
}

// ---------------- Document conversion ----------------
async function convertDocument(input, outPath, targetExt, tmpDir) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  const inExt = extOfFilename(input) || extOfFilename(path.basename(input));
  // keep the requested target casing if provided in targetExt; also use lowercased local 'ext' for logic
  const extRequested = (targetExt || path.extname(outPath)).toString().replace(/^\./, "");
  const ext = extRequested.toLowerCase();
  const out = fixOutputExtension(outPath, extRequested);
  tmpDir = tmpDir || path.dirname(input);

  // Prefer pdftocairo if available (better color accuracy & direct jpeg)
  const pdftocairoAvailable = await hasPdftocairo();
  const magickCmd = await findMagickCmd();

  // PDF -> images (single-page)
  if (inExt === "pdf" && ["png","jpg","jpeg","webp","tiff","bmp"].includes(ext)) {
    const format = (ext === "jpg" || ext === "jpeg") ? "jpeg" : (ext === "webp" ? "png" : ext); // pdftocairo doesn't reliably write webp -> convert later
    const prefix = path.join(tmpDir, safeOutputBase(path.parse(input).name));
    if (pdftocairoAvailable && format !== "webp") {
      // use pdftocairo for jpeg/png/tiff which is reliable
      const cmd = `pdftocairo -singlefile -${format} -r 300 "${input}" "${prefix}"`;
      console.log("📄 pdftocairo:", cmd);
      await runCmd(cmd).catch(err => { throw new Error(`pdftocairo failed: ${err.message}`); });
      const produced = `${prefix}.${format}`;
      if (!fs.existsSync(produced)) {
        const alt = `${prefix}-1.${format}`;
        if (fs.existsSync(alt)) { await fsp.rename(alt, out); return out; }
        throw new Error("pdftocairo did not produce page image");
      }
      // if requested webp, convert produced png/jpeg to webp via ImageMagick
      if (ext === "webp") {
        const tmpWebp = fixOutputExtension(produced, `webp`);
        if (magickCmd) {
          await runCmd(`${magickCmd} "${produced}" "${tmpWebp}"`).catch(err => { throw new Error(`imagemagick failed: ${err.message}`); });
          await safeCleanup(produced);
          await flattenImageWhite(tmpWebp, out);
          await safeCleanup(tmpWebp);
          return out;
        } else {
          await fsp.rename(produced, out);
          return out;
        }
      }
      // flatten produced to white background (handles transparency/dark bg)
      await flattenImageWhite(produced, out);
      await safeCleanup(produced);
      // normalize jpeg casing exactly as requested
      if ((extRequested === "JPG" || extRequested === "jpg" || extRequested === "jpeg") && (ext === "jpeg" || ext === "jpg")) {
        // if user requested uppercase JPG specifically, rename accordingly
        const desired = fixOutputExtension(out, extRequested);
        if (desired !== out && fs.existsSync(out)) {
          await fsp.rename(out, desired).catch(()=>{});
          return desired;
        }
      }
      return out;
    } else {
      // fallback to pdftoppm (older) but avoid unsupported -webp option
      const cmd = `pdftoppm -f 1 -singlefile -${format} "${input}" "${prefix}"`;
      console.log("📄 pdftoppm (fallback):", cmd);
      await runCmd(cmd).catch(err => { throw new Error(`pdftoppm failed: ${err.message}`); });
      const produced = `${prefix}.${format}`;
      if (!fs.existsSync(produced)) {
        const alt = `${prefix}-1.${format}`;
        if (fs.existsSync(alt)) { await fsp.rename(alt, out); return out; }
        throw new Error("pdftoppm did not produce page image");
      }
      if (ext === "webp" && magickCmd) {
        const tmpWebp = fixOutputExtension(produced, `webp`);
        await runCmd(`${magickCmd} "${produced}" "${tmpWebp}"`).catch(err => { throw new Error(`imagemagick failed: ${err.message}`); });
        await safeCleanup(produced);
        await flattenImageWhite(tmpWebp, out);
        await safeCleanup(tmpWebp);
        return out;
      }
      await flattenImageWhite(produced, out);
      await safeCleanup(produced);
      // honor requested casing for jpeg/JPG
      if ((extRequested === "JPG" || extRequested === "jpg" || extRequested === "jpeg") && (ext === "jpeg" || ext === "jpg")) {
        const desired = fixOutputExtension(out, extRequested);
        if (desired !== out && fs.existsSync(out)) {
          await fsp.rename(out, desired).catch(()=>{});
          return desired;
        }
      }
      return out;
    }
  }

  // PDF -> text / md
  if (inExt === "pdf" && ["txt","md"].includes(ext)) {
    if (await hasCmd("pdftotext")) {
      const mid = path.join(tmpDir, `${safeOutputBase(path.parse(input).name)}.txt`);
      // extract plain text without rendering background
      await runCmd(`pdftotext "${input}" "${mid}"`).catch(err => { throw new Error(`pdftotext failed: ${err.message}`); });
      if (ext === "md") {
        if (await hasCmd("pandoc")) {
          // convert plain text to markdown using the extracted text file
          await runCmd(`pandoc "${mid}" -o "${out}"`).catch(err => { throw new Error(`pandoc failed: ${err.message}`); });
          await safeCleanup(mid);
          return out;
        } else {
          // if pandoc not available, return txt (renamed to .md) as fallback
          await fsp.rename(mid, out).catch(()=>{});
          return out;
        }
      }
      // ext === txt
      await fsp.rename(mid, out);
      return out;
    } else throw new Error("pdftotext not available for PDF->text conversion");
  }

  // PDF -> docx via pdftotext + pandoc (best-effort)
  if (inExt === "pdf" && ext === "docx") {
    if (await hasCmd("pdftotext") && await hasCmd("pandoc")) {
      const mid = path.join(tmpDir, `${safeOutputBase(path.parse(input).name)}.txt`);
      await runCmd(`pdftotext "${input}" "${mid}"`);
      await runCmd(`pandoc "${mid}" -o "${out}"`);
      await safeCleanup(mid);
      return out;
    }
  }

  // Office conversions via LibreOffice
  if (officeExts.has(inExt) || officeExts.has(ext) || inExt === "pdf") {
    const cmd = `libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to ${ext} "${input}" --outdir "${tmpDir}"`;
    console.log("📄 libreoffice:", cmd);
    await runCmd(cmd).catch(err => { throw new Error(`LibreOffice conversion failed: ${err.message}`); });
    const gen = path.join(tmpDir, `${path.parse(input).name}.${ext}`);
    if (!fs.existsSync(gen)) throw new Error(`LibreOffice failed to produce ${ext}`);
    // flatten produced images to avoid dark backgrounds
    if (["png","jpg","jpeg","webp"].includes(ext)) await flattenImageWhite(gen, gen);
    await fsp.rename(gen, out).catch(()=>{});
    if (!(await waitForStableFileSize(out))) throw new Error("Document conversion failed: output unstable or empty");
    // honor requested casing for jpeg/JPG
    if ((ext === "jpeg" || ext === "jpg") && extRequested && extRequested !== ext) {
      const desired = fixOutputExtension(out, extRequested);
      if (desired !== out && fs.existsSync(out)) {
        await fsp.rename(out, desired).catch(()=>{});
        return desired;
      }
    }
    return out;
  }

  throw new Error(`Unsupported document conversion: ${inExt} -> ${ext}`);
}

// ---------------- Compression (heavy) - overwrite same extension ----------------
async function compressFile(input, outPath, inputExt) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  inputExt = (inputExt || extOfFilename(input)).replace(/^\./, "").toLowerCase();
  const out = fixOutputExtension(outPath, inputExt);

  let cmd;
  if (inputExt === "pdf") {
    cmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${out}" "${input}"`;
  } else if (imageExts.has(inputExt) || ["jpg","jpeg","png","webp"].includes(inputExt)) {
    if (["jpg","jpeg"].includes(inputExt)) {
      cmd = `magick "${input}" -strip -sampling-factor 4:2:0 -quality 55 -interlace Plane -colorspace sRGB "${out}"`;
    } else if (inputExt === "png") {
      if (await hasCmd("pngquant")) {
        cmd = `pngquant --quality=50-80 --output "${out}" --force "${input}"`;
      } else {
        cmd = `magick "${input}" -strip -quality 60 "${out}"`;
      }
    } else {
      cmd = `magick "${input}" -strip -quality 60 "${out}"`;
    }
  } else if (audioExts.has(inputExt)) {
    cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -ac 2 -ar 44100 -b:a 96k "${out}"`;
  } else if (videoExts.has(inputExt)) {
    if (inputExt === "webm") {
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libvpx -b:v 600k -cpu-used 5 -row-mt 1 -c:a libopus -b:a 64k -f webm "${out}"`;
    } else {
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libx264 -preset veryfast -crf 35 -c:a aac -b:a 96k "${out}"`;
    }
  } else if (officeExts.has(inputExt) || docExts.has(inputExt)) {
    // convert to PDF then compress -> return compressed PDF (naked file)
    const tmpPdf = fixOutputExtension(outPath, "pdf");
    if (await hasCmd("pandoc") && docExts.has(inputExt)) {
      await runCmd(`pandoc "${input}" -o "${tmpPdf}"`).catch(()=>{});
    } else {
      await runCmd(`libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to pdf "${input}" --outdir "${path.dirname(tmpPdf)}"`).catch(()=>{});
    }
    await runCmd(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${tmpPdf}" "${tmpPdf}"`).catch(()=>{});
    if (!fs.existsSync(tmpPdf)) throw new Error("Document compression failed");
    if (!(await waitForStableFileSize(tmpPdf))) throw new Error("Document compression produced unstable output");
    return tmpPdf;
  } else {
    throw new Error(`Compression not supported for .${inputExt}`);
  }

  console.log("🗜️ compress cmd:", cmd);
  await runCmd(cmd).catch(err => { throw new Error(`Compression failed: ${err.message}`); });

  if (!fs.existsSync(out)) throw new Error("Compression failed: output missing");
  if (!(await waitForStableFileSize(out))) throw new Error("Compression failed: output unstable or empty");

  return await ensureProperExtension(out, inputExt);
}

// ---------------- Route: POST '/' ----------------
router.post("/", (req, res) => {
  // disable default timeouts for long conversions
  try { req.setTimeout(0); } catch (e) {}
  try { res.setTimeout(0); } catch (e) {}

  upload(req, res, async function (err) {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    const mode = (req.body.mode || "convert").toLowerCase(); // convert | compress
    // capture raw requested target to preserve casing, and also a normalized lowercase for logic
    const requestedTargetRaw = (req.body.targetFormat || "").toString().replace(/^\./, "");
    const requestedTarget = (requestedTargetRaw || "").toLowerCase();
    const inputPath = req.file.path;
    const originalName = sanitizeFilename(req.file.originalname);
    const inputExt = extOfFilename(originalName) || extOfFilename(inputPath);
    const tmpDir = path.dirname(inputPath);

    const magickCmd = await findMagickCmd();
    const baseOut = path.join(TMP_DIR, safeOutputBase(originalName));
    // use requestedTargetRaw for casing in filenames if provided, otherwise use inputExt
    const effectiveTarget = requestedTargetRaw || inputExt;
    const outPath = fixOutputExtension(baseOut, effectiveTarget);

    let producedPath;

    try {
      // Guard: identical source and target format => disallow
      if (mode === "convert" && requestedTarget && requestedTarget === inputExt) {
        await safeCleanup(inputPath);
        return res.status(400).json({ error: `Conversion disallowed: source and target formats are identical (.${inputExt})` });
      }

      if (mode === "compress") {
        producedPath = await compressFile(inputPath, outPath, inputExt);
      } else { // convert
        // Prefer video handling for webm and other video targets (webm treated as video)
        if (audioExts.has(inputExt) || audioExts.has(requestedTarget)) {
          producedPath = await convertAudio(inputPath, outPath, requestedTargetRaw || requestedTarget || inputExt);
        } else if (videoExts.has(inputExt) || videoExts.has(requestedTarget)) {
          producedPath = await convertVideo(inputPath, outPath, requestedTargetRaw || requestedTarget || inputExt);
        } else if (inputExt === "pdf" || docExts.has(inputExt) || docExts.has(requestedTarget) || officeExts.has(requestedTarget)) {
          producedPath = await convertDocument(inputPath, outPath, requestedTargetRaw || requestedTarget || inputExt, tmpDir);
        } else if (imageExts.has(inputExt) || imageExts.has(requestedTarget)) {
          if (!magickCmd) throw new Error("ImageMagick not available");
          const cmd = `${magickCmd} "${inputPath}" "${outPath}"`;
          console.log("🖼️ imagemagick:", cmd);
          await runCmd(cmd);
          producedPath = await ensureProperExtension(outPath, requestedTargetRaw || requestedTarget || inputExt);
          // flatten to white to avoid dark background artifacts
          if (["png","jpg","jpeg","webp"].includes(extOfFilename(producedPath))) {
            const tmpFlat = fixOutputExtension(producedPath, `flat.${extOfFilename(producedPath)}`);
            await flattenImageWhite(producedPath, tmpFlat);
            await fsp.rename(tmpFlat, producedPath).catch(()=>{});
          }
        } else {
          throw new Error(`Unsupported file type: .${inputExt}`);
        }
      }

      // Validate produced file
      if (!producedPath || !fs.existsSync(producedPath)) throw new Error("Output not produced.");
      if (!(await waitForStableFileSize(producedPath))) throw new Error("Produced file is empty or unstable.");

      // Ensure final extension: if user explicitly requested a target use their casing
      if (mode === "compress") {
        producedPath = await ensureProperExtension(producedPath, inputExt);
      } else {
        const finalTarget = requestedTargetRaw || extOfFilename(producedPath) || inputExt;
        producedPath = await ensureProperExtension(producedPath, finalTarget);
      }

      // ensure extension exists - sometimes ffmpeg/libreoffice may produce file without extension
      if (!path.extname(producedPath)) {
        const extWanted = requestedTargetRaw || extOfFilename(producedPath) || inputExt;
        const withExt = `${producedPath}.${extWanted}`;
        if (fs.existsSync(producedPath)) {
          await fsp.rename(producedPath, withExt).catch(()=>{ producedPath = producedPath; });
          producedPath = withExt;
        }
      }

      const outExt = extOfFilename(producedPath);
      const fileName = `${path.parse(originalName).name.replace(/\s+/g, "_")}.${outExt}`;
      const mimeType = mapMimeByExt(outExt);
      const stat = fs.statSync(producedPath);

      // Stream file using pipeline and wait for completion before cleanup (prevents premature close / network fail)
      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });

      const readStream = fs.createReadStream(producedPath);

      // When pipeline resolves, the full file has been sent.
      await pipe(readStream, res);

      // cleanup only after full send
      await safeCleanup(producedPath);
      await safeCleanup(inputPath);
      // NOTE: response already ended by pipeline

    } catch (e) {
      console.error("❌ Conversion/Compression error:", e && e.message);
      // try to remove partial produced file if any
      try { if (producedPath) await safeCleanup(producedPath); } catch (er) {}
      await safeCleanup(inputPath);
      if (!res.headersSent) return res.status(500).json({ error: e.message });
      // if headers already sent, we can't send JSON; just end connection
      try { res.end(); } catch {}
    }
  });
});

module.exports = router;
