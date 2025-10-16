// =====================================================
// 🌍 UNIVERSAL FILE TOOL
// Works perfectly with CommonJS backend (server.js)
// =====================================================

// --- DOM Elements ---
const drop = document.getElementById("drop");
const fileInput = document.getElementById("fileInput");
const preview = document.getElementById("preview");
const actionSelect = document.getElementById("action");
const formatSelect = document.getElementById("format");
const qualityInput = document.getElementById("quality");
const processBtn = document.getElementById("processBtn");
const message = document.getElementById("message");

let selectedFile = null;

// --- Format Categories ---
const formatOptions = {
  image: ["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff"],
  document: ["pdf", "txt", "docx", "html"],
  audio: ["mp3", "wav", "ogg", "m4a"],
  video: ["mp4", "avi", "mkv", "mov", "webm"]
};

// =====================================================
// 📂 FILE HANDLING
// =====================================================
drop.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));

drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("dragover");
});

drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));

drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("dragover");
  handleFile(e.dataTransfer.files[0]);
});

function handleFile(file) {
  if (!file) return;
  selectedFile = file;
  drop.querySelector("#dropText").textContent = file.name;

  const type = file.type;
  const category = type.startsWith("image/")
    ? "image"
    : type.startsWith("video/")
    ? "video"
    : type.startsWith("audio/")
    ? "audio"
    : "document";

  populateFormatSelect(category);
  showPreview(file);
}

// =====================================================
// 🎯 POPULATE TARGET FORMAT OPTIONS
// =====================================================
function populateFormatSelect(category) {
  formatSelect.innerHTML = "";
  const options = formatOptions[category] || [];

  options.forEach((fmt) => {
    const opt = document.createElement("option");
    opt.value = fmt;
    opt.textContent = fmt.toUpperCase();
    formatSelect.appendChild(opt);
  });
}

// =====================================================
// 🖼️ FILE PREVIEW
// =====================================================
function showPreview(file) {
  const fileURL = URL.createObjectURL(file);
  const type = file.type;

  preview.style.display = "block";

  if (type.startsWith("image/")) {
    preview.innerHTML = `<img src="${fileURL}" style="max-width:100%;border-radius:12px;">`;
  } else if (type.startsWith("video/")) {
    preview.innerHTML = `<video controls src="${fileURL}" style="width:100%;border-radius:12px;"></video>`;
  } else if (type.startsWith("audio/")) {
    preview.innerHTML = `<audio controls src="${fileURL}" style="width:100%;"></audio>`;
  } else if (type === "application/pdf") {
    preview.innerHTML = `
      <iframe src="${fileURL}" type="application/pdf" 
              style="width:100%;height:500px;border:none;border-radius:12px;">
      </iframe>
      <small style="color:#666;">PDF Preview</small>`;
  } else {
    preview.innerHTML = `<div style="padding:10px;color:#444;">
      Selected file: <strong>${file.name}</strong><br>
      Size: ${(file.size / 1024).toFixed(1)} KB
    </div>`;
  }
}

// =====================================================
// ⚙️ ACTION HANDLER
// =====================================================
actionSelect.addEventListener("change", () => {
  const action = actionSelect.value;
  formatSelect.disabled = action === "compress"; // freeze during compression
});

// =====================================================
// 🚀 PROCESS FILE
// =====================================================
processBtn.addEventListener("click", async () => {
  if (!selectedFile) {
    showMessage("⚠️ Please upload a file first.");
    return;
  }

  const action = actionSelect.value;
  const targetFormat = formatSelect.value;
  const quality = qualityInput.value || 80;

  const inputExt = selectedFile.name.split(".").pop().toLowerCase();

  // Prevent same-format conversion
  if (action === "convert" && targetFormat === inputExt) {
    showMessage("⚠️ Cannot convert file to the same format.");
    return;
  }

  const formData = new FormData();
  formData.append("file", selectedFile);
  formData.append("action", action);
  formData.append("targetFormat", targetFormat);
  formData.append("quality", quality);

  processBtn.disabled = true;
  showMessage("⏳ Processing file, please wait...");

  try {
    const response = await fetch("http://localhost:3000/process", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error("❌ Processing error");
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);

    const contentDisposition = response.headers.get("Content-Disposition");
    let filename = "processed_file";
    if (contentDisposition && contentDisposition.includes("filename=")) {
      filename = contentDisposition.split("filename=")[1].replace(/['"]/g, "");
    }

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    window.URL.revokeObjectURL(url);
    showMessage("✅ File processed and downloaded successfully!");
  } catch (err) {
    console.error("❌ Error:", err);
    showMessage("❌ Processing failed. Please try again.");
  } finally {
    processBtn.disabled = false;
  }
});

// =====================================================
// 💬 MESSAGE DISPLAY
// =====================================================
function showMessage(msg) {
  message.textContent = msg;
  message.style.display = "block";
}
