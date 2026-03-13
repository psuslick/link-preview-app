export default function PreviewCard({ url, type, thumbnail }) {
  return (
    <div className="preview-card">
      <div className="thumb-wrapper">
        {thumbnail ? (
          thumbnail.startsWith("http")
            ? <img src={thumbnail} alt="preview" />
            : <img src={thumbnail} alt="preview" />
        ) : (
          <div className="placeholder">No Preview</div>
        )}
      </div>

      <div className="info">
        <div className="url">{url}</div>
        <div className="type">{type}</div>
      </div>
    </div>
  );
}