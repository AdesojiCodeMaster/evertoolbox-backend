// universal-filetool.js (FINAL - corrected and integrated)
// Requirements in runtime image: ffmpeg, libreoffice, poppler-utils (pdftoppm/pdftotext/pdftocairo), ghostscript (gs),
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
const STABLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

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

async function hasCmd(name) { try { await runCmd(`which ${name}`); return true; } catch { return false; } }
async function findMagickCmd() { try { await runCmd("magick -version"); return "magick"; } catch { try { await runCmd("convert -version"); return "convert"; } catch { return null; } } }

// ---------------- Utilities ----------------
function extOfFilename(name) { return (path.extname(name || "").replace(".", "") || "").toLowerCase(); }
function sanitizeFilename(name) { return path.basename(name).replace(/[^a-zA-Z0-9._\- ]/g, "_"); }
function safeOutputBase(originalName) { return `${Date.now()}-${uuidv4()}-${path.parse(originalName).name.replace(/\s+/g, "_")}`; }

// IMPORTANT: preserve requested case for extension when the user supplied it.
// fixOutputExtension and ensureProperExtension intentionally DO NOT lower-case the extension.
function fixOutputExtension(filename, targetExt) {
	if (!targetExt) return filename;
	const clean = (targetExt || "").toString().replace(/^\./, "");
	if (!clean) return filename;
	const dir = path.dirname(filename);
	const base = path.parse(filename).name;
	return path.join(dir, `${base}.${clean}`);
}
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
			runCmd("pdftocairo -v").catch(()=>{}),
			runCmd("pdftotext -v").catch(()=>{}),
			runCmd("magick -version").catch(()=>runCmd("convert -version").catch(()=>{})),
			runCmd("gs --version").catch(()=>{})
		]);
		console.log("🔥 Prewarm done");
	} catch (e) { console.warn("Prewarm notice:", e && e.message); }
})();

// ---------------- Helper: flatten image to white (not used by default for PDF->image) ----------------
async function flattenImageWhite(input, out) {
	if (await hasCmd("magick")) {
		const cmd = `magick "${input}" -background white -alpha remove -alpha off "${out}"`;
		await runCmd(cmd);
	} else {
		await fsp.copyFile(input, out);
	}
}

// ---------------- Audio conversion (ensures extensions present) ----------------
async function convertAudio(input, outPath, targetExt) {
	if (!fs.existsSync(input)) throw new Error("Input file not found");
	const extRaw = (targetExt || path.extname(outPath)).toString().replace(/^\./, "");
	const ext = extRaw.toLowerCase();
	if (!ext) throw new Error("No target audio extension specified");

	let out = fixOutputExtension(outPath, extRaw);
	if (!path.extname(out)) out = `${out}.${extRaw}`;

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
			// preserve requested case for extension (.opus or .OPUS if requested)
			out = fixOutputExtension(out, targetExt || "opus");
			cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a libopus -b:a 96k -vn "${out}"`;
			break;
		case "aac":
			out = fixOutputExtension(out, targetExt || "aac");
			cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a aac -b:a 128k -f adts "${out}"`;
			break;
		case "m4a":
			out = fixOutputExtension(out, targetExt || "m4a");
			cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a aac -b:a 128k "${out}"`;
			break;
		case "flac":
			out = fixOutputExtension(out, targetExt || "flac");
			cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -c:a flac "${out}"`;
			break;
		case "webm":
			// audio-only webm
			out = fixOutputExtension(out, targetExt || "webm");
			cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:a -vn -c:a libopus -b:a 96k -f webm "${out}"`;
			break;
		default:
			throw new Error(`Unsupported target audio format: ${ext}`);
	}

	console.log("🎬 ffmpeg (audio):", cmd);
	await runCmd(cmd);

	// Ensure extension / casing requested by caller
	out = await ensureProperExtension(out, targetExt || extRaw);

	if (!fs.existsSync(out)) throw new Error("Audio conversion failed: output missing");
	if (!(await waitForStableFileSize(out))) throw new Error("Audio conversion failed: output unstable or empty");

	return out;
}

// ---------------- Video conversion ----------------
async function convertVideo(input, outPath, targetExt) {
	if (!fs.existsSync(input)) throw new Error("Input file not found");
	const extRaw = (targetExt || path.extname(outPath)).toString().replace(/^\./, "");
	const ext = extRaw.toLowerCase();
	if (!ext) throw new Error("No target video extension specified");

	let out = fixOutputExtension(outPath, extRaw);
	if (!path.extname(out)) out = `${out}.${extRaw}`;

	// Build commands depending on target
	if (ext === "webm") {
		// Try VP9 with Opus (video+audio). If that fails, fallback to VP8.
		const tryVp9 = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:v -map 0:a -c:v libvpx-vp9 -b:v 1M -cpu-used 4 -row-mt 1 -c:a libopus -b:a 128k -f webm "${out}"`;
		console.log("🎬 ffmpeg (video - try vp9):", tryVp9);
		try {
			await runCmd(tryVp9);
		} catch (errVp9) {
			console.warn("VP9 failed, falling back to VP8:", errVp9 && errVp9.message);
			const fallbackVp8 = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:v -map 0:a -c:v libvpx -b:v 1M -cpu-used 5 -row-mt 1 -c:a libopus -b:a 128k -f webm "${out}"`;
			console.log("🎬 ffmpeg (video - fallback vp8):", fallbackVp8);
			await runCmd(fallbackVp8);
		}
	} else if (ext === "mkv") {
		const cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:v -map 0:a -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 96k "${out}"`;
		console.log("🎬 ffmpeg (video):", cmd);
		await runCmd(cmd);
	} else if (["mp4","mov","m4v","avi"].includes(ext)) {
		const cmd = `ffmpeg -y -threads ${FFMPEG_THREADS} -i "${input}" -map 0:v -map 0:a -c:v libx264 -preset fast -crf 28 -c:a aac -b:a 128k "${out}"`;
		console.log("🎬 ffmpeg (video):", cmd);
		await runCmd(cmd);
	} else {
		// container-only copy for unknown/other containers
		const cmd = `ffmpeg -y -i "${input}" -c copy "${out}"`;
		console.log("🎬 ffmpeg (container copy):", cmd);
		await runCmd(cmd);
	}

	if (!fs.existsSync(out)) throw new Error("Video conversion failed: output missing");
	if (!(await waitForStableFileSize(out))) throw new Error("Video conversion failed: output unstable or empty");

	out = await ensureProperExtension(out, targetExt || extRaw);
	return out;
}

// ---------------- Document conversion ----------------
async function convertDocument(input, outPath, targetExt, tmpDir) {
	if (!fs.existsSync(input)) throw new Error("Input file not found");
	const inExt = extOfFilename(input) || extOfFilename(path.basename(input));
	const extRaw = (targetExt || path.extname(outPath)).toString().replace(/^\./, "");
	const ext = extRaw.toLowerCase();
	const out = fixOutputExtension(outPath, extRaw);
	tmpDir = tmpDir || path.dirname(input);

	// PDF -> images (single-page) with multiple fallbacks
	if (inExt === "pdf" && ["png","jpg","jpeg","webp"].includes(ext)) {
		const format = (ext === "jpg" || ext === "jpeg") ? "jpeg" : ext;
		const prefix = path.join(tmpDir, safeOutputBase(path.parse(input).name));

		// Try pdftoppm
		try {
			const cmd = `pdftoppm -f 1 -singlefile -${format} "${input}" "${prefix}"`;
			console.log("📄 pdftoppm:", cmd);
			await runCmd(cmd);
			const candidate1 = `${prefix}.${format}`;
			const candidate2 = `${prefix}-1.${format}`;
			let produced = null;
			if (fs.existsSync(candidate1)) produced = candidate1;
			else if (fs.existsSync(candidate2)) produced = candidate2;

			if (produced) {
				await fsp.rename(produced, out).catch(()=>{});
				if (!(await waitForStableFileSize(out))) throw new Error("Produced image unstable after pdftoppm");
				console.log("✅ PDF->image produced by pdftoppm:", out);
				return await ensureProperExtension(out, targetExt || extRaw);
			} else {
				console.warn("pdftoppm ran but did not create expected output files");
			}
		} catch (e) {
			console.warn("pdftoppm failed:", e.message);
		}

		// Try pdftocairo
		try {
			const cmd = `pdftocairo -f 1 -singlefile -${format} "${input}" "${prefix}"`;
			console.log("📄 pdftocairo:", cmd);
			await runCmd(cmd);
			const tmpOut = `${prefix}.${format}`;
			if (fs.existsSync(tmpOut)) {
				await fsp.rename(tmpOut, out).catch(()=>{});
				if (!(await waitForStableFileSize(out))) throw new Error("Produced image unstable after pdftocairo");
				console.log("✅ PDF->image produced by pdftocairo:", out);
				return await ensureProperExtension(out, targetExt || extRaw);
			} else {
				console.warn("pdftocairo did not produce expected file:", tmpOut);
			}
		} catch (e) {
			console.warn("pdftocairo failed:", e.message);
		}

		// ImageMagick fallback — avoid black/dark background by disabling alpha or removing transparency
		const magickCmd = await findMagickCmd();
		if (magickCmd) {
			try {
				// use -alpha off to drop alpha; -density for quality
				const cmd = `${magickCmd} -density 150 -alpha off "${input}[0]" "${out}"`;
				console.log("📄 ImageMagick fallback:", cmd);
				await runCmd(cmd);
				if (!fs.existsSync(out)) throw new Error("ImageMagick did not produce output");
				if (!(await waitForStableFileSize(out))) throw new Error("Produced image unstable after ImageMagick");
				console.log("✅ PDF->image produced by ImageMagick:", out);
				return await ensureProperExtension(out, targetExt || extRaw);
			} catch (e) {
				console.warn("ImageMagick fallback failed:", e.message);
				// Try another ImageMagick invocation that forces background white (last resort)
				try {
					const cmd2 = `${magickCmd} -density 150 "${input}[0]" -background white -alpha remove -alpha off "${out}"`;
					console.log("📄 ImageMagick fallback 2 (force white):", cmd2);
					await runCmd(cmd2);
					if (fs.existsSync(out)) {
						if (!(await waitForStableFileSize(out))) throw new Error("Produced image unstable after ImageMagick fallback2");
						return await ensureProperExtension(out, targetExt || extRaw);
					}
				} catch (e2) {
					console.warn("ImageMagick fallback2 failed:", e2.message);
				}
			}
		} else {
			console.warn("No ImageMagick available for PDF->image fallback");
		}

		throw new Error("PDF -> image conversion failed: pdftoppm, pdftocairo and ImageMagick all failed or did not produce output");
	}

	// PDF -> text / md
	if (inExt === "pdf" && ["txt","md"].includes(ext)) {
		if (await hasCmd("pdftotext")) {
			const mid = path.join(tmpDir, `${safeOutputBase(path.parse(input).name)}.txt`);
			// layout & UTF-8 encoding
			await runCmd(`pdftotext -layout -enc UTF-8 "${input}" "${mid}"`);
			if (ext === "md" && await hasCmd("pandoc")) {
				await runCmd(`pandoc "${mid}" -t markdown -o "${out}"`);
				await safeCleanup(mid);
				return out;
			}
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

	// Office conversions via LibreOffice (explicit filters + robust detection)
	if (officeExts.has(inExt) || officeExts.has(ext) || inExt === "pdf") {
		let filter = "";
		const lowIn = inExt.toLowerCase();
		const lowOut = ext.toLowerCase();

		if (["ppt","pptx"].includes(lowIn)) {
			if (lowOut === "pdf") filter = "impress_pdf_Export";
			else if (["png","jpg","jpeg"].includes(lowOut)) filter = "impress_png_Export";
		} else if (["xls","xlsx"].includes(lowIn)) {
			if (lowOut === "pdf") filter = "calc_pdf_Export";
			else if (lowOut === "html") filter = "calc_html_Export";
		} else if (["doc","docx","odt"].includes(lowIn)) {
			if (lowOut === "pdf") filter = "writer_pdf_Export";
		}

		const filterArg = filter ? `:${filter}` : "";
		const cmd = `libreoffice --headless --invisible --nologo --nodefault --nolockcheck --convert-to ${ext}${filterArg} "${input}" --outdir "${tmpDir}"`;
		console.log("📄 libreoffice:", cmd);
		await runCmd(cmd);

		// Collect candidate names (LibreOffice sometimes varies output naming)
		const baseName = path.parse(input).name;
		let genCandidates = [
			path.join(tmpDir, `${baseName}.${ext}`),
			path.join(tmpDir, `${baseName}.${ext.toUpperCase()}`),
			path.join(tmpDir, `${baseName}_converted.${ext}`),
			path.join(tmpDir, `${baseName}-converted.${ext}`)
		];

		// add any matching files in tmpDir that start with baseName and end with ext
		try {
			const dirFiles = fs.readdirSync(tmpDir);
			for (const f of dirFiles) {
				if (f.startsWith(baseName) && f.toLowerCase().endsWith(`.${ext}`)) {
					genCandidates.push(path.join(tmpDir, f));
				}
			}
		} catch (e) { /* ignore read errors */ }

		const gen = genCandidates.find(p => fs.existsSync(p));
		if (!gen) throw new Error(`LibreOffice failed to produce ${ext}`);

		await fsp.rename(gen, out).catch(()=>{});
		if (!(await waitForStableFileSize(out))) throw new Error("Document conversion failed: output unstable or empty");
		console.log(`✅ LibreOffice ${lowIn}->${lowOut} success:`, out);
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
		// preserve raw requested extension casing if provided
		const requestedTargetRaw = (req.body.targetFormat || "").toString().replace(/^\./, "");
		const requestedTarget = requestedTargetRaw.toString().toLowerCase();
		const inputPath = req.file.path;
		const originalName = sanitizeFilename(req.file.originalname);
		const inputExt = extOfFilename(originalName) || extOfFilename(inputPath);
		const tmpDir = path.dirname(inputPath);

		const magickCmd = await findMagickCmd();
		const baseOut = path.join(TMP_DIR, safeOutputBase(originalName));
		const effectiveTargetLower = requestedTarget || inputExt; // lowercase target for logic
		// but outPath should use requested casing (requestedTargetRaw) if available
		const outPath = fixOutputExtension(baseOut, requestedTargetRaw || effectiveTargetLower);

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
				// Prefer video classification first (fixes mp4 -> webm being handled as audio-only)
				if (videoExts.has(inputExt) || videoExts.has(effectiveTargetLower)) {
					producedPath = await convertVideo(inputPath, outPath, requestedTargetRaw || effectiveTargetLower);
				} else if (audioExts.has(inputExt) || audioExts.has(effectiveTargetLower)) {
					producedPath = await convertAudio(inputPath, outPath, requestedTargetRaw || effectiveTargetLower);
				} else if (inputExt === "pdf" || docExts.has(inputExt) || docExts.has(effectiveTargetLower) || officeExts.has(effectiveTargetLower) || officeExts.has(inputExt)) {
					producedPath = await convertDocument(inputPath, outPath, requestedTargetRaw || effectiveTargetLower, tmpDir);
				} else if (imageExts.has(inputExt) || imageExts.has(effectiveTargetLower)) {
					if (!magickCmd) throw new Error("ImageMagick not available");
					// For image->image conversions, preserve background / remove alpha to avoid black backgrounds
					const cmd = `${magickCmd} "${inputPath}" -background white -alpha remove -alpha off "${outPath}"`;
					console.log("🖼️ imagemagick:", cmd);
					await runCmd(cmd);
					producedPath = await ensureProperExtension(outPath, requestedTargetRaw || effectiveTargetLower);
				} else {
					throw new Error(`Unsupported file type: .${inputExt}`);
				}
			}

			// Validate produced file
			if (!producedPath || !fs.existsSync(producedPath)) throw new Error("Output not produced.");
			if (!(await waitForStableFileSize(producedPath))) throw new Error("Produced file is empty or unstable.");

			// Ensure final extension (preserve requested casing if provided)
			if (mode === "compress") {
				producedPath = await ensureProperExtension(producedPath, inputExt);
			} else {
				const finalTargetCased = requestedTargetRaw || extOfFilename(producedPath) || inputExt;
				producedPath = await ensureProperExtension(producedPath, finalTargetCased);
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
			console.error("❌ Conversion/Compression error:", e && (e.message || e));
			// try to remove partial produced file if any
			try { if (producedPath) await safeCleanup(producedPath); } catch (er) {}
			await safeCleanup(inputPath);
			if (!res.headersSent) return res.status(500).json({ error: (e && (e.message || String(e))) });
			// if headers already sent, we can't send JSON; just end connection
			try { res.end(); } catch {}
		}
	});
});

module.exports = router;
