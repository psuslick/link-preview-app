// Single-process, memory-only UI workspace. Not persisted to disk or browser
// storage; vanishes when the Sandbox backend terminates.
export class WorkspaceRamStore {
  constructor({ maxBytes = 4 * 1024 * 1024 } = {}) {
    this.maxBytes = maxBytes;
    this.state = null;
    this.revision = 0;
  }
  read() { return { ok: true, revision: this.revision, state: this.state }; }
  save(payload, baseRevision) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        payload.schema !== 1 || !Array.isArray(payload.previews) || !Array.isArray(payload.finderJobs)) {
      return { ok: false, status: 400, error: "invalid_workspace_schema" };
    }
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > this.maxBytes) return { ok: false, status: 413, error: "workspace_too_large" };
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) return { ok: false, status: 400, error: "invalid_workspace_revision" };
    if (baseRevision !== this.revision) {
      return { ok: false, status: 409, error: "workspace_revision_conflict", revision: this.revision };
    }
    this.state = payload;
    this.revision += 1;
    return { ok: true, revision: this.revision };
  }
}
