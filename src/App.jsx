import { useState } from "react";
import VideoGrid from "./components/VideoGrid";
import "./App.css";

export default function App() {
  const [input, setInput] = useState("");
  const [videos, setVideos] = useState([]);

  const handleProcess = () => {
    const links = input
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    setVideos(links);
  };

const testConnection = async () => {
  try {
    const res = await fetch(`${import.meta.env.VITE_API_URL}/health`);

    if (!res.ok) {
      alert("❌ Backend responded, but with an error status.");
      return;
    }

    alert("✅ Backend connection successful!");
  } catch (err) {
    alert("❌ Cannot reach backend. Check if the server is running.");
  }
};


  return (
    <div className="app">
      <h1>Video Preview Grid</h1>

      <textarea
        className="input-box"
        placeholder="Paste video links here, one per line..."
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />

      <div className="button-row">
        <button className="process-btn" onClick={handleProcess}>
          Generate Previews
        </button>

        <button className="process-btn test-btn" onClick={testConnection}>
          Test Connection
        </button>
      </div>

      <VideoGrid videos={videos} />
    </div>
  );
}