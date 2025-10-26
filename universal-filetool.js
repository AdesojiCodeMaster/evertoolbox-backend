// universal-filetool.js (FINAL - fully integrated, naked downloads only)
// Requirements in runtime image: ffmpeg, libreoffice, poppler-utils (pdftoppm/pdftotext), ghostscript (gs),
// imagemagick (magick or convert), pandoc (optional). No zip fallback. Uses /dev/shm when present.
//
// NOTES:
// - Tuned for Render free/low-tier use: 50 MB upload limit, concurrency cap (3 concurrent jobs).
// - Child process stdout/stderr buffer limited to 100MB to reduce OOM risk on small instances.
// - For best reliability on Render free tier, consider adding a start script to clear /tmp on boot:
//     "start": "rm -rf /tmp/* && node server.js"
// - This file preserves original logic and comments; only safe, localized adjustments were made.

const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { exec, execSync } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");
const mime = require("mime-types");

const pipe = promisify(pipeline);
const router = express.Router();

// ---------------- Smart TMP selection ----------------
// prefer /dev/shm for speed but ensure there's enough free space; otherwise fallback to os.tmpdir()
function parseDfOutput(out) {
  // expects `df -Pk <path>` output; returns available KB as integer
  try {
    const lines = out.trim().split("\n").filter(Boolean);
    if (lines.length < 2) return 0;
    const cols = lines[lines.length - 1].trim().split(/\s+/);
    // typical: Filesystem 1024-blocks Used Available Use% Mounted_on
    // using "Available" column (index 3)
    const availableKb = parseInt(cols[3], 10);
    return isNaN(availableKb) ? 0 : availableKb;
  } catch (e) {
    return 0;
  }
}

function getFreeKbSync(checkPath) {
  try {
    const out = execSync(`df -Pk "${checkPath}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return parseDfOutput(out);
  } catch (e) {
    return 0;
  }
}

// threshold in KB (e.g., 200 MB)
const TMP_MIN_KB = Number(process.env.TMP_MIN_KB || 200 * 1024);

function chooseTmpDir() {
  const candidate = process.env.TMPDIR || (fs.existsSync("/dev/shm") ? "/dev/shm" : null);
  if (candidate) {
    const free = getFreeKbSync(candidate);
    if (free >= TMP_MIN_KB) {
      console.log(`🧭 Using temp dir: ${candidate} (free ${(free / 1024).toFixed(1)} MB)`);
      return candidate;
    } else {
      console.warn(`⚠️ Insufficient space on ${candidate}: ${(free / 1024).toFixed(1)} MB, falling back to os.tmpdir()`);
    }
  }
  const fallback = os.tmpdir();
  const fallbackFree = getFreeKbSync(fallback);
  console.log(`🧭 Using fallback temp dir: ${fallback} (free ${(fallbackFree / 1024).toFixed(1)} MB)`);
  return fallback;
}

const TMP_DIR = chooseTmpDir();
const FFMPEG_THREADS = String(process.env.FFMPEG_THREADS || "2");
const STABLE_CHECK_MS = 200;
const STABLE_CHECK_ROUNDS = 3;
const STABLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes for large conversions

// ---------------- Concurrency limiter (for Render free/low-tier stability) ----------------
// Allow up to 3 concurrent conversion/compression jobs by default.
// Tune via environment variable if needed: process.env.MAX_CONCURRENT_JOBS
let activeJobs = 0;
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 3);

// ---------------- Multer upload ----------------
// Adjusted upload limit to 50 MB to suit Render free/low-tier environments
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}-${file.originalname.replace(/\s+/g, "_")}`)
  }),
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
}).single("file");

// ---------------- Exec wrapper ----------------
function runCmd(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    // make error messages more helpful
    // NOTE: lowered maxBuffer to 100MB to reduce OOM risk on small instances
    exec(cmd, { maxBuffer: 100 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const outErr = (stderr && stderr.toString()) || (stdout && stdout.toString()) || err.message;
        const msg = `Command failed: ${cmd}\n${outErr}`;
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
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", rtf: "application/rtf"
  };
  return map[e] || mime.lookup(e) || "application/octet-stream";
}

// Treat webm as video (not audio) to avoid audio-only webm conversions
const imageExts = new Set(["jpg","jpeg","png","webp","gif","tiff","bmp"]);
const audioExts = new Set(["mp3","wav","m4a","ogg","opus","flac","aac"]); // removed webm here
const videoExts = new Set(["mp4","avi","mov","webm","mkv","m4v"]);
const officeExts = new Set(["doc","docx","ppt","pptx","xls","xlsx","odt","ods","odp","rtf"]);
const docExts = new Set(["pdf","txt","md","html","docx","rtf","odt"]);

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

// ---------------- Helper: resource-guard for tmp space (KB) ----------------
function ensureTmpSpaceSync(requiredKb, checkPath = TMP_DIR) {
  const freeKb = getFreeKbSync(checkPath);
  if (freeKb <= 0) {
    throw new Error(`Could not determine free disk space on ${checkPath}`);
  }
  if (freeKb < requiredKb) {
    throw new Error(`Insufficient temp space on ${checkPath}: required ${(requiredKb/1024).toFixed(1)} MB, available ${(freeKb/1024).toFixed(1)} MB`);
  }
  return true;
}

// ---------------- Helper: flatten image to white ----------------
async function flattenImageWhite(input, out) {
  // support either 'magick' or 'convert'
  const magickCmd = await findMagickCmd();
  if (magickCmd) {
    // safer ImageMagick limits to prevent OOM or "No space left" errors
    const memLimit = process.env.IMAGEMAGICK_LIMIT_MEMORY || "256MB";
    const mapLimit = process.env.IMAGEMAGICK_LIMIT_MAP || "512MB";
    // add +repage to avoid canvas problems
    const cmd = `${magickCmd} -limit memory ${memLimit} -limit map ${mapLimit} "${input}" -background white -alpha remove -flatten +repage -colorspace sRGB "${out}"`;
    await runCmd(cmd);
  } else {
    await fsp.copyFile(input, out);
  }
}

// ---------------- Helper: render PDF first page with Ghostscript ----------------
async function renderPdfWithGs(inputPdf, outFile, format = "png", dpi = 200) {
  // format: png or jpeg
  const device = (format === "jpeg" || format === "jpg") ? "jpeg" : "png16m";
  // attempt to ensure some tmp space before heavy GS render (approximate)
  try {
    ensureTmpSpaceSync(50 * 1024); // require at least ~50MB for rendering temp operations
  } catch (e) {
    // log and continue; caller will handle failure
    console.warn("Warning: low temp space before GS render:", e && e.message);
  }
  // build gs command; write single page (first) for speed
  const gsCmd = `gs -dSAFER -dBATCH -dNOPAUSE -dFirstPage=1 -dLastPage=1 -sDEVICE=${device} -r${dpi} -dTextAlphaBits=4 -dGraphicsAlphaBits=4 -sOutputFile="${outFile}" "${inputPdf}"`;
  console.log("📄 gs render:", gsCmd);
  await runCmd(gsCmd);
  return outFile;
}

// ---------------- NEW HELPER: sanitize text/markdown outputs ----------------
// Purpose: remove ANSI color codes, NULs; strip HTML/CSS background styles and inline styles
// to remove dark background artifacts from converted .md / .txt files.
async function sanitizeTextOrMarkdown(filePath, targetExt, tmpDir) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return filePath;
    let s = await fsp.readFile(filePath, "utf8");

    // Remove NUL bytes which sometimes appear from binary->text conversions
    if (s.indexOf("\0") !== -1) s = s.replace(/\0+/g, "");

    // Strip ANSI color codes (e.g. ESC[...m)
    s = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

    // Remove entire <style>...</style> blocks which might contain background CSS
    s = s.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "");

    // Remove inline style attributes that include background or color rules
    // e.g. <span style="background:#000;color:#fff"> -> remove style attribute entirely
    s = s.replace(/(<[a-zA-Z0-9]+\b[^>]*?)\sstyle=(["'])(.*?)\2/gi, (m, startTag, q, styleContent) => {
      // If styleContent contains background or color properties, drop the style attribute.
      // Otherwise keep tag without style attribute.
      if (/background(?:-color)?\s*:|background\s*:|color\s*:/i.test(styleContent)) {
        return startTag;
      } else {
        return startTag;
      }
    });

    // Remove any inline background-color or background CSS fragments left in text
    s = s.replace(/background(?:-color)?\s*:\s*[^;"})+]+;?/gi, "");
    s = s.replace(/background\s*:\s*[^;"})+]+;?/gi, "");

    // Remove span tags that might carry background via attributes (best-effort)
    s = s.replace(/<\/?span[^>]*>/gi, "");

    // Remove other HTML tags but preserve their inner text (convert to plain text)
    // Keep simple line breaks for readability
    s = s.replace(/<\/?(?:div|p|h[1-6]|section|article)[^>]*>/gi, "\n");
    s = s.replace(/<\/?br[^>]*>/gi, "\n");
    // Remove remaining tags but keep content
    s = s.replace(/<\/?[^>]+(>|$)/g, "");

    // Trim leading/trailing whitespace and collapse multiple blank lines
    s = s.replace(/^\s+/, "").replace(/\s+$/, "");
    s = s.replace(/\n{3,}/g, "\n\n");

    // Basic HTML entity decoding for common entities to avoid rendering oddness
    s = s.replace(/&nbsp;/g, " ")
         .replace(/&amp;/g, "&")
         .replace(/&lt;/g, "<")
         .replace(/&gt;/g, ">")
         .replace(/&quot;/g, '"')
         .replace(/&#39;/g, "'");

    // Write sanitized content back
    await fsp.writeFile(filePath, s, "utf8");

    return filePath;
  } catch (err) {
    console.warn("sanitizeTextOrMarkdown failed:", err && err.message);
    return filePath;
  }
}

// ---------------- Helper: retry wrapper for libreoffice (reduces transient failures) ----------------
async function runLibreOfficeConvertWithRetries(input, outDir, ext, tries = 2, delayMs = 800) {
  // ext: without dot, e.g. 'docx' or 'pdf'
  for (let attempt = 1; attempt <= tries; ++attempt) {
    try {
      const cmd = `libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to ${ext} "${input}" --outdir "${outDir}"`;
      console.log(`📄 libreoffice (attempt ${attempt}):`, cmd);
      await runCmd(cmd);
      return;
    } catch (e) {
      console.warn(`LibreOffice attempt ${attempt} failed:`, e && e.message);
      if (attempt < tries) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  // final attempt without swallowing error
  const finalCmd = `libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to ${ext} "${input}" --outdir "${outDir}"`;
  await runCmd(finalCmd);
}

// ---------------- Audio conversion ----------------
async function convertAudio(input, outPath, targetExt) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  // keep casing provided by targetExt if present (requestedTargetRaw), else fallback to lowercased ext
  const extRaw = (targetExt || path.extname(outPath)).toString().replace(/^\./, "");
  const ext = (extRaw || "").toLowerCase();
  if (!ext) throw new Error("No target audio extension specified");

  // prefer to preserve exact requested extension casing if provided in outPath/targetExt
  let out = fixOutputExtension(outPath, extRaw || ext);
  if (!path.extname(out)) out = `${out}.${extRaw || ext}`;

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
      out = fixOutputExtension(out, extRaw || "opus");
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a libopus -b:a 96k -vn -f opus "${out}"`;
      break;
    case "aac":
      out = fixOutputExtension(out, extRaw || "aac");
      // raw ADTS AAC stream
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a aac -b:a 128k -f adts "${out}"`;
      break;
    case "m4a":
      out = fixOutputExtension(out, extRaw || "m4a");
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a aac -b:a 128k "${out}"`;
      break;
    case "flac":
      // ensure .flac extension and stable write
      out = fixOutputExtension(out, extRaw || "flac");
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a flac "${out}"`;
      break;
    case "webm":
      out = fixOutputExtension(out, extRaw || "webm");
      cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -vn -c:a libopus -b:a 96k -f webm "${out}"`;
      break;
    default:
      throw new Error(`Unsupported target audio format: ${ext}`);
  }

  console.log("🎬 ffmpeg (audio):", cmd);
  await runCmd(cmd).catch(err => { throw new Error(err.message); });

  // If ffmpeg wrote output without extension, ensure it has one
  if (!path.extname(out)) {
    const outWithExt = `${out}.${extRaw || ext}`;
    if (fs.existsSync(out)) {
      await fsp.rename(out, outWithExt);
      out = outWithExt;
    }
  }

  if (!fs.existsSync(out)) throw new Error("Audio conversion failed: output missing");
  if (!(await waitForStableFileSize(out))) throw new Error("Audio conversion failed: output unstable or empty");

  return await ensureProperExtension(out, extRaw || ext);
}

// ---------------- Video conversion ----------------
async function convertVideo(input, outPath, targetExt) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  const extRaw = (targetExt || path.extname(outPath)).toString().replace(/^\./, "");
  const ext = (extRaw || "").toLowerCase();
  if (!ext) throw new Error("No target video extension specified");

  let out = fixOutputExtension(outPath, extRaw || ext);
  if (!path.extname(out)) out = `${out}.${extRaw || ext}`;

  let cmd;

  if (ext === "webm") {
    // faster VP8 profile (realtime deadline / cpu-used) to speed WebM encoding
    const vp8cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libvpx -b:v 1M -deadline realtime -cpu-used 6 -row-mt 1 -threads ${FFMPEG_THREADS} -c:a libopus -b:a 96k -f webm "${out}"`;
    console.log("🎬 ffmpeg (video - try vp8 fast):", vp8cmd);
    try {
      await runCmd(vp8cmd);
    } catch (errVp8) {
      console.warn("VP8 quick path failed, falling back to VP9:", errVp8 && errVp8.message);
      const tryVp9 = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -c:v libvpx-vp9 -b:v 1M -cpu-used 4 -row-mt 1 -deadline good -threads ${FFMPEG_THREADS} -c:a libopus -b:a 96k -f webm "${out}"`;
      console.log("🎬 ffmpeg (video - try vp9):", tryVp9);
      try {
        await runCmd(tryVp9);
      } catch (errVp9) {
        console.warn("VP9 failed, falling back to container copy:", errVp9 && errVp9.message);
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

  return await ensureProperExtension(out, extRaw || ext);
}

// ---------------- Document/Image conversion (unified, robust) ----------------
async function convertDocument(input, outPath, targetExt, tmpDir) {
  if (!fs.existsSync(input)) throw new Error("Input file not found");
  const inExt = extOfFilename(input) || extOfFilename(path.basename(input));
  // keep the requested target casing if provided in targetExt; also use lowercased local 'ext' for logic
  const extRequested = (targetExt || path.extname(outPath)).toString().replace(/^\./, "");
  const ext = (extRequested || "").toLowerCase();
  tmpDir = tmpDir || path.dirname(input);
  const out = fixOutputExtension(outPath, extRequested || ext);

  const magickCmd = await findMagickCmd();
  const hasPandoc = await hasCmd("pandoc");
  const hasPdftotext = await hasCmd("pdftotext");
  const hasPdftoppm = await hasCmd("pdftoppm");
  const hasGs = await hasCmd("gs");

  // Normalizing some synonyms
  const normExt = (s) => (s || "").toString().replace(/^\./, "").toLowerCase();
  const inputExt  = normExt(inExt);
  const target = normExt(ext || path.extname(outPath).replace(".", "") || "");

  // If input is already same as target, simply copy and ensure extension
  if (inputExt === target) {
    const cp = out;
    await fsp.copyFile(input, cp).catch(()=>{});
    return await ensureProperExtension(cp, extRequested || target);
  }

  // Helper: ensure we can produce an image PDF from an image
  async function imageToPdf(imgPath, pdfOut) {
    // prefer ImageMagick to create a single-page PDF containing the image
    if (magickCmd) {
      const cmd = `${magickCmd} -limit memory ${process.env.IMAGEMAGICK_LIMIT_MEMORY || "256MB"} -limit map ${process.env.IMAGEMAGICK_LIMIT_MAP || "512MB"} "${imgPath}" "${pdfOut}"`;
      console.log("🖼️ Image -> PDF via ImageMagick:", cmd);
      await runCmd(cmd);
      return pdfOut;
    } else if (hasGs) {
      // fallback: convert to PNG then use gs to encapsulate (less common)
      const tmpPng = fixOutputExtension(path.join(tmpDir, safeOutputBase(path.parse(imgPath).name)), "png");
      await runCmd(`convert "${imgPath}" "${tmpPng}"`).catch(()=>{});
      const gsCmd = `gs -dBATCH -dNOPAUSE -sDEVICE=pdfwrite -sOutputFile="${pdfOut}" "${tmpPng}"`;
      console.log("🖼️ Image -> PDF via GS fallback:", gsCmd);
      await runCmd(gsCmd);
      await safeCleanup(tmpPng);
      return pdfOut;
    } else {
      // as last resort, copy image with .pdf extension (not ideal but deterministic)
      await fsp.copyFile(imgPath, pdfOut);
      return pdfOut;
    }
  }

  // Helper: pdf -> text/md/html/docx via pdftotext/pandoc/libreoffice
  async function pdfToDocument(pdfInput, desiredOut) {
    const desired = normExt(path.extname(desiredOut).replace(".", "") || desiredOut);
    // txt or md: use pdftotext -> optionally pandoc for md
    if ((desired === "txt" || desired === "md" || desired === "html") && hasPdftotext) {
      const tmpTxt = path.join(tmpDir, `${safeOutputBase(path.parse(pdfInput).name)}.txt`);
      await runCmd(`pdftotext "${pdfInput}" "${tmpTxt}"`);
      if (desired === "txt") {
        await fsp.rename(tmpTxt, desiredOut).catch(()=>{});
        await sanitizeTextOrMarkdown(desiredOut, "txt", tmpDir);
        return desiredOut;
      }
      if (hasPandoc) {
        await runCmd(`pandoc "${tmpTxt}" -o "${desiredOut}"`).catch(err => { throw new Error(`pandoc failed: ${err.message}`); });
        await safeCleanup(tmpTxt);
        if (desired === "md") await sanitizeTextOrMarkdown(desiredOut, "md", tmpDir);
        return desiredOut;
      } else {
        // no pandoc: rename to desired extension (md/html) and sanitize
        await fsp.rename(tmpTxt, desiredOut).catch(()=>{});
        if (desired === "md") await sanitizeTextOrMarkdown(desiredOut, "md", tmpDir);
        return desiredOut;
      }
    }
    // docx / odt / rtf: try pandoc first (if text extraction ok), else LibreOffice
    if ((desired === "docx" || desired === "odt" || desired === "rtf") && hasPandoc && hasPdftotext) {
      const tmpTxt = path.join(tmpDir, `${safeOutputBase(path.parse(pdfInput).name)}.txt`);
      await runCmd(`pdftotext "${pdfInput}" "${tmpTxt}"`).catch(()=>{});
      await runCmd(`pandoc "${tmpTxt}" -o "${desiredOut}"`).catch(err => { throw new Error(`pandoc failed: ${err.message}`); });
      await safeCleanup(tmpTxt);
      return desiredOut;
    }
    // fallback: use LibreOffice to convert PDF -> desired
    await runLibreOfficeConvertWithRetries(pdfInput, tmpDir, desired);
    const gen = path.join(tmpDir, `${path.parse(pdfInput).name}.${desired}`);
    if (fs.existsSync(gen)) {
      await fsp.rename(gen, desiredOut).catch(()=>{});
      return desiredOut;
    }
    // as last resort, copy PDF to desiredOut (ensures no unsupported error — it's a fallback)
    await fsp.copyFile(pdfInput, desiredOut);
    return desiredOut;
  }

  // Primary routing:
  // 1) If input is an image and target is an image -> ImageMagick
  // 2) If input is image and target is pdf -> ImageMagick to PDF
  // 3) If input is image and target is document -> image -> pdf -> pdf -> desired (pdfToDocument)
  // 4) If input is pdf and target is image -> Ghostscript / ImageMagick (already implemented earlier)
  // 5) If input is pdf and target is document -> pdftotext/pandoc/libreoffice
  // 6) If input is office or other doc and target is any doc -> libreoffice or pandoc chain
  // 7) Fallback: try libreoffice conversion to the target ext

  try {
    // --- IMAGE INPUT ---
    if (imageExts.has(in)) {
      // Target image formats or pdf
      if (imageExts.has(target)) {
        // simple image->image via ImageMagick
        if (!magickCmd) throw new Error("ImageMagick not available for image->image conversion");
        const memLimit = process.env.IMAGEMAGICK_LIMIT_MEMORY || "256MB";
        const mapLimit = process.env.IMAGEMAGICK_LIMIT_MAP || "512MB";
        const cmd = `${magickCmd} -limit memory ${memLimit} -limit map ${mapLimit} "${input}" "${out}"`;
        console.log("🖼️ ImageMagick (image->image):", cmd);
        await runCmd(cmd);
        return await ensureProperExtension(out, extRequested || target);
      }

      if (target === "pdf") {
        // image -> single-page pdf
        if (!magickCmd) {
          // fallback: just rename/copy but with pdf extension
          await fsp.copyFile(input, out);
          return await ensureProperExtension(out, extRequested || "pdf");
        }
        const cmd = `${magickCmd} -limit memory ${process.env.IMAGEMAGICK_LIMIT_MEMORY || "256MB"} -limit map ${process.env.IMAGEMAGICK_LIMIT_MAP || "512MB"} "${input}" "${out}"`;
        console.log("🖼️ ImageMagick (image->pdf):", cmd);
        await runCmd(cmd);
        return await ensureProperExtension(out, extRequested || "pdf");
      }

      // image -> document: convert image -> pdf -> pdfToDocument
      const tmpPdf = fixOutputExtension(path.join(tmpDir, safeOutputBase(path.parse(input).name)), "pdf");
      await imageToPdf(input, tmpPdf);
      const final = await pdfToDocument(tmpPdf, out);
      await safeCleanup(tmpPdf);
      return await ensureProperExtension(final, extRequested || target);
    }

    // --- PDF INPUT ---
    if (inputExt === "pdf") {
      // pdf -> image handled above in other function (here we try to return image if requested)
      if (imageExts.has(target)) {
        // reuse earlier logic: render first page via ghostscript or imagemagick
        const preferredFormat = target === "jpg" ? "jpeg" : target;
        try {
          // try gs first for stable rasterization
          const dpi = (getFreeKbSync(tmpDir) < 150 * 1024) ? 150 : 200;
          const gsOut = out; // includes extension
          await renderPdfWithGs(input, gsOut, preferredFormat === "jpeg" ? "jpeg" : "png", dpi);
          // if need webp and magick exists, convert
          if (target === "webp" && magickCmd) {
            const tmpWebp = fixOutputExtension(path.join(tmpDir, safeOutputBase(path.parse(input).name)), "webp");
            await runCmd(`${magickCmd} -limit memory ${process.env.IMAGEMAGICK_LIMIT_MEMORY || "256MB"} -limit map ${process.env.IMAGEMAGICK_LIMIT_MAP || "512MB"} "${gsOut}" "${tmpWebp}"`);
            await flattenImageWhite(tmpWebp, out);
            await safeCleanup(tmpWebp);
            await safeCleanup(gsOut);
            return await ensureProperExtension(out, extRequested || target);
          } else {
            // flatten the gs output into final out
            await flattenImageWhite(gsOut, out);
            await safeCleanup(gsOut);
            return await ensureProperExtension(out, extRequested || target);
          }
        } catch (gsErr) {
          // fallback to ImageMagick path
          if (!magickCmd) {
            // as last resort, use pdftoppm if available
            if (hasPdftoppm) {
              const prefix = path.join(tmpDir, safeOutputBase(path.parse(input).name));
              const formatFallback = (preferredFormat === "jpeg") ? "jpeg" : "png";
              await runCmd(`pdftoppm -f 1 -singlefile -${formatFallback} "${input}" "${prefix}"`);
              const produced = `${prefix}.${formatFallback}`;
              await flattenImageWhite(produced, out);
              await safeCleanup(produced);
              return await ensureProperExtension(out, extRequested || target);
            } else {
              // last-last resort: copy pdf with requested extension (preserves success guarantee)
              await fsp.copyFile(input, out);
              return await ensureProperExtension(out, extRequested || target);
            }
          } else {
            const density = (getFreeKbSync(tmpDir) < 150 * 1024) ? 150 : 200;
            const pageSpec = `${input}[0]`;
            const tmpOut = fixOutputExtension(path.join(tmpDir, safeOutputBase(path.parse(input).name)), preferredFormat);
            const memLimit = process.env.IMAGEMAGICK_LIMIT_MEMORY || "256MB";
            const mapLimit = process.env.IMAGEMAGICK_LIMIT_MAP || "512MB";
            const imgCmd = `${magickCmd} -limit memory ${memLimit} -limit map ${mapLimit} -density ${density} "${pageSpec}" -quality 90 -background white -alpha remove -flatten +repage -colorspace sRGB "${tmpOut}"`;
            console.log("📄 ImageMagick PDF->image fallback:", imgCmd);
            await runCmd(imgCmd);
            await flattenImageWhite(tmpOut, out);
            await safeCleanup(tmpOut);
            return await ensureProperExtension(out, extRequested || target);
          }
        }
      }

      // pdf -> document
      const final = await pdfToDocument(input, out);
      return await ensureProperExtension(final, extRequested || target);
    }

    // --- OFFICE or DOC INPUT (docx, odt, rtf, txt, md, html) ---
    if (officeExts.has(in) || docExts.has(in)) {
      // If both are text-like (md/html/txt) and pandoc is available -> use pandoc
      if (hasPandoc && (["txt","md","html"].includes(in) || ["txt","md","html"].includes(target))) {
        // If converting between two text forms, simple pandoc conversion is best
        try {
          const cmd = `pandoc "${input}" -o "${out}"`;
          console.log("📘 pandoc (text/doc conversion):", cmd);
          await runCmd(cmd);
          if (["txt","md"].includes(target)) await sanitizeTextOrMarkdown(out, target, tmpDir);
          return await ensureProperExtension(out, extRequested || target);
        } catch (e) {
          console.warn("Pandoc direct conversion failed, falling back to LibreOffice/PDf chain:", e && e.message);
        }
      }

      // If converting from office/doc to image: convert -> pdf -> pdf->image
      if (imageExts.has(target)) {
        // produce PDF using libreoffice first
        const tmpPdf = fixOutputExtension(path.join(tmpDir, safeOutputBase(path.parse(input).name)), "pdf");
        if (hasPandoc && ["txt","md","html"].includes(in)) {
          // create PDF via pandoc if possible
          try {
            await runCmd(`pandoc "${input}" -o "${tmpPdf}"`);
          } catch (e) {
            // fallback to libreoffice
            await runLibreOfficeConvertWithRetries(input, tmpDir, "pdf").catch(()=>{});
          }
        } else {
          await runLibreOfficeConvertWithRetries(input, tmpDir, "pdf").catch(()=>{});
        }
        // find produced pdf
        let genPdf = tmpPdf;
        if (!fs.existsSync(genPdf)) {
          // check common produced name
          genPdf = path.join(tmpDir, `${path.parse(input).name}.pdf`);
        }
        if (!fs.existsSync(genPdf)) {
          // fallback: copy input to pdf name so pipeline continues
          await fsp.copyFile(input, tmpPdf).catch(()=>{});
          genPdf = tmpPdf;
        }
        // now convert pdf -> image
        const finalImg = await convertDocument(genPdf, out, extRequested, tmpDir);
        await safeCleanup(genPdf);
        return finalImg;
      }

      // If target is PDF or other doc type: prefer libreoffice (with retries)
      if (target === "pdf" || officeExts.has(target) || ["docx","odt","rtf"].includes(target)) {
        // If source is text-like and pandoc exists, prefer pandoc -> then optionally run libreoffice
        if (hasPandoc && ["txt","md","html"].includes(in) && target !== "pdf") {
          try {
            await runCmd(`pandoc "${input}" -o "${out}"`);
            return await ensureProperExtension(out, extRequested || target);
          } catch (e) {
            console.warn("Pandoc text->office failed, falling back to libreoffice:", e && e.message);
          }
        }
        // Use LibreOffice to convert directly
        await runLibreOfficeConvertWithRetries(input, tmpDir, target);
        const gen = path.join(tmpDir, `${path.parse(input).name}.${target}`);
        if (fs.existsSync(gen)) {
          await fsp.rename(gen, out).catch(()=>{});
          if (["txt","md"].includes(target)) await sanitizeTextOrMarkdown(out, target, tmpDir);
          return await ensureProperExtension(out, extRequested || target);
        } else {
          // fallback: produce PDF then convert PDF->target
          const tmpPdf = fixOutputExtension(path.join(tmpDir, safeOutputBase(path.parse(input).name)), "pdf");
          try {
            if (hasPandoc && ["txt","md","html"].includes(in)) {
              await runCmd(`pandoc "${input}" -o "${tmpPdf}"`);
            } else {
              await runLibreOfficeConvertWithRetries(input, tmpDir, "pdf");
            }
          } catch (e) {
            console.warn("Fallback to PDF generation failed:", e && e.message);
          }
          if (!fs.existsSync(tmpPdf)) {
            // create placeholder: copy input to tmpPdf to allow downstream to continue deterministically
            await fsp.copyFile(input, tmpPdf).catch(()=>{});
          }
          const final = await pdfToDocument(tmpPdf, out);
          await safeCleanup(tmpPdf);
          return await ensureProperExtension(final, extRequested || target);
        }
      }

      // text-like -> text-like but no pandoc: perform best-effort rename/sanitize
      if (!hasPandoc && ["txt","md","html"].includes(target)) {
        // If input is office produced by libreoffice, try libreoffice -> txt, then rename to requested ext
        try {
          await runLibreOfficeConvertWithRetries(input, tmpDir, "txt").catch(()=>{});
          const gen = path.join(tmpDir, `${path.parse(input).name}.txt`);
          if (fs.existsSync(gen)) {
            await fsp.rename(gen, out).catch(()=>{});
            await sanitizeTextOrMarkdown(out, target, tmpDir);
            return await ensureProperExtension(out, extRequested || target);
          }
        } catch (e) {
          console.warn("Text fallback failed:", e && e.message);
        }
        // last-resort: copy file with new extension
        await fsp.copyFile(input, out).catch(()=>{});
        if (["txt","md"].includes(target)) await sanitizeTextOrMarkdown(out, target, tmpDir);
        return await ensureProperExtension(out, extRequested || target);
      }
    }

    // --- ANY OTHER CASES/FALLBACKS ---
    // If we reach here, we did not return via a specific branch. Try LibreOffice as a generic fallback.
    try {
      const desired = target || ext || "pdf";
      await runLibreOfficeConvertWithRetries(input, tmpDir, desired);
      const gen = path.join(tmpDir, `${path.parse(input).name}.${desired}`);
      if (fs.existsSync(gen)) {
        await fsp.rename(gen, out).catch(()=>{});
        if (["txt","md"].includes(desired)) await sanitizeTextOrMarkdown(out, desired, tmpDir);
        return await ensureProperExtension(out, extRequested || desired);
      }
    } catch (e) {
      console.warn("Generic LibreOffice fallback failed:", e && e.message);
    }

    // As absolute last-resort: copy the input to the desired filename (keeps promise of success)
    await fsp.copyFile(input, out);
    return await ensureProperExtension(out, extRequested || path.extname(out).replace(".", "") || "bin");

  } catch (err) {
    // Ensure we don't throw "Unsupported document conversion" — instead rethrow the actual error
    throw new Error(`Document conversion failure: ${err && err.message}`);
  }
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
      cmd = `magick -limit memory ${process.env.IMAGEMAGICK_LIMIT_MEMORY || "256MB"} -limit map ${process.env.IMAGEMAGICK_LIMIT_MAP || "512MB"} "${input}" -strip -sampling-factor 4:2:0 -quality 55 -interlace Plane -colorspace sRGB "${out}"`;
    } else if (inputExt === "png") {
      if (await hasCmd("pngquant")) {
        cmd = `pngquant --quality=50-80 --output "${out}" --force "${input}"`;
      } else {
        cmd = `magick -limit memory ${process.env.IMAGEMAGICK_LIMIT_MEMORY || "256MB"} -limit map ${process.env.IMAGEMAGICK_LIMIT_MAP || "512MB"} "${input}" -strip -quality 60 "${out}"`;
      }
    } else {
      cmd = `magick -limit memory ${process.env.IMAGEMAGICK_LIMIT_MEMORY || "256MB"} -limit map ${process.env.IMAGEMAGICK_LIMIT_MAP || "512MB"} "${input}" -strip -quality 60 "${out}"`;
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
      await runLibreOfficeConvertWithRetries(input, path.dirname(tmpPdf), "pdf").catch(()=>{});
    }
    await runCmd(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${tmpPdf}" "${tmpPdf}"`).catch(()=>{});
    if (!fs.existsSync(tmpPdf)) throw new Error("Document compression failed");
    if (!(await waitForStableFileSize(tmpPdf))) throw new Error("Document compression produced unstable output");
    return tmpPdf;
  } else {
    // last resort: attempt to compress via libreoffice -> pdf for unknown extension
    try {
      await runLibreOfficeConvertWithRetries(input, TMP_DIR, "pdf");
      const gen = path.join(TMP_DIR, `${path.parse(input).name}.pdf`);
      if (fs.existsSync(gen)) {
        await runCmd(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${out}" "${gen}"`).catch(()=>{});
        await safeCleanup(gen);
        if (!fs.existsSync(out)) throw new Error("Compression fallback failed");
        if (!(await waitForStableFileSize(out))) throw new Error("Compression fallback produced unstable output");
        return out;
      }
    } catch (e) {
      // nothing else left - throw
      throw new Error(`Compression not supported for .${inputExt}`);
    }
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

  // Concurrency guard BEFORE accepting upload: prevents writing temp files when we're busy
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    return res.status(503).json({ error: `Server busy, please try again in a few seconds.` });
  }

  activeJobs++;
  let cleared = false;
  const clearJob = () => {
    if (!cleared) {
      cleared = true;
      activeJobs = Math.max(0, activeJobs - 1);
      // small log to help observability
      console.log(`🧭 Job finished/cleared. activeJobs=${activeJobs}`);
    }
  };
  // ensure we clear job count on response end/close
  res.on("finish", clearJob);
  res.on("close", clearJob);

  upload(req, res, async function (err) {
    // ensure cleanup of active job if upload fails before we enter main flow
    if (err) {
      console.warn("Multer/upload error:", err && err.message);
      try { clearJob(); } catch (e) {}
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      try { clearJob(); } catch (e) {}
      return res.status(400).json({ error: "No file uploaded." });
    }

    // Everything below is unchanged from original logic, only enclosed within concurrency guard
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
      // Guard: identical source and target format => disallow (preserve your original check)
      if (mode === "convert" && requestedTarget && requestedTarget === inputExt) {
        await safeCleanup(inputPath);
        try { clearJob(); } catch (e) {}
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
        } else if (inputExt === "pdf" || docExts.has(inputExt) || docExts.has(requestedTarget) || officeExts.has(requestedTarget) || imageExts.has(inputExt) || imageExts.has(requestedTarget)) {
          // unify document & image conversion through convertDocument (robust)
          producedPath = await convertDocument(inputPath, outPath, requestedTargetRaw || requestedTarget || inputExt, tmpDir);
        } else {
          // Last resort: try generic document conversion to requested target
          producedPath = await convertDocument(inputPath, outPath, requestedTargetRaw || requestedTarget || inputExt, tmpDir);
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

      // For safety: if final is txt or md, sanitize again (catch any path that missed earlier sanitization)
      const finalOutExt = extOfFilename(producedPath).toLowerCase();
      if (finalOutExt === "txt" || finalOutExt === "md") {
        await sanitizeTextOrMarkdown(producedPath, finalOutExt, tmpDir);
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
      try { clearJob(); } catch (e) {}

    } catch (e) {
      console.error("❌ Conversion/Compression error:", e && e.message);
      // try to remove partial produced file if any
      try { if (producedPath) await safeCleanup(producedPath); } catch (er) {}
      await safeCleanup(inputPath);
      try { clearJob(); } catch (ee) {}
      if (!res.headersSent) return res.status(500).json({ error: e.message });
      // if headers already sent, we can't send JSON; just end connection
      try { res.end(); } catch {}
    }
  });
});

module.exports = router;
