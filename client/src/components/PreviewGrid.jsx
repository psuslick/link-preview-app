import React from "react";
import "./PreviewGrid.css";

export default function PreviewGrid({ items }) {
  return (
    <div className="preview-grid">
      {items.map((item) => (
        <a
          key={item.url}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="preview-card"
        >
          <img src={item.screenshot} alt="Video preview" />
        </a>
      ))}
    </div>
  );
}