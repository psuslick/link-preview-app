import express from "express";
import cors from "cors";
import previewRoute from "./routes/preview.js";
import previewBatchRoute from "./routes/previewBatch.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.use("/api/preview", previewRoute);
app.use("/api/preview/batch", previewBatchRoute);

app.get("/", (req, res) => {
  res.send("Hybrid preview engine running");
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Hybrid engine running on port ${PORT}`);
});