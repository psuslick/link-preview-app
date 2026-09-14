import http from "node:http";
import net from "node:net";

export async function resolveViaDnsGovernor(hostname, { timeoutMs = 6500 } = {}) {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (!host) throw new Error("missing_hostname");
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];

  const token = process.env.LINK_PREVIEW_DNS_GOVERNOR_TOKEN;
  const port = Number(process.env.LINK_PREVIEW_DNS_GOVERNOR_PORT || 3000);
  if (!token) throw new Error("dns_governor_unavailable");

  return await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: `/internal/dns-resolve?host=${encodeURIComponent(host)}`,
      headers: { "X-Link-Preview-DNS-Token": token, Connection: "close" }
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= 64 * 1024) chunks.push(chunk);
      });
      res.once("end", () => {
        if (bytes > 64 * 1024) return reject(new Error("dns_governor_response_too_large"));
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
        catch { return reject(new Error("dns_governor_invalid_response")); }
        if (res.statusCode !== 200 || !data?.ok || !Array.isArray(data.addresses)) {
          const error = new Error(data?.error || `dns_governor_status_${res.statusCode || 0}`);
          if (data?.code) error.code = data.code;
          return reject(error);
        }
        resolve(data.addresses);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("dns_governor_timeout")));
    req.once("error", reject);
    req.end();
  });
}
