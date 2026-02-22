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

  return (
    <div className="app">
      <h1>Video Preview Grid</h1>

      <textarea
        className="input-box"
        placeholder="Paste video links here, one per line..."
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />

      <button className="process-btn" onClick={handleProcess}>
        Generate Previews
      </button>

      <VideoGrid videos={videos} />
    </div>
  );
}