import { useEffect, useState } from "react";
import axios from "axios";

export default function VideoGrid({ videos }) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    const fetchAll = async () => {
      const results = await Promise.all(
        videos.map(async (url) => {
          const res = await axios.post("http://localhost:4000/scrape", { url });
          return res.data;
        })
      );
      setItems(results);
    };

    if (videos.length > 0) fetchAll();
  }, [videos]);

  return (
    <div className="video-grid">
      {items.map((item, i) => (
        <div
          key={i}
          className="video-tile"
          onClick={() => window.open(item.url, "_blank")}
        >
          {item.thumbnail ? (
            <img src={item.thumbnail} alt={item.title || "Thumbnail"} />
          ) : (
            <div className="unsupported">No thumbnail found</div>
          )}
          <div className="title">{item.title || "Untitled"}</div>
        </div>
      ))}
    </div>
  );
}