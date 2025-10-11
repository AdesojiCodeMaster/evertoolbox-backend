import fileRouter from "./routes/filetools_v5.js";

export function attachFileTool(app) {
  try {
    app.use("/api/tools/file", fileRouter);
    console.log("✅ File Converter & Compressor tool loaded");
  } catch (err) {
    console.error("⚠️ Failed to load File Converter Tool:", err);
  }
}
