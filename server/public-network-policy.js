import net from "node:net";

// A single fail-closed public-address policy for previews and every isolated
// browser/media safety proxy. Use Node's binary IP parser rather than matching
// IPv6 text, which misses compressed IPv4-mapped forms such as ::ffff:7f00:1.
// Subnets reflect private, non-routable, and special-use ranges (IANA registries).
const blockedV4 = new net.BlockList();
for (const [base, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) blockedV4.addSubnet(base, bits, "ipv4");

const globallyRoutableV6 = new net.BlockList();
globallyRoutableV6.addSubnet("2000::", 3, "ipv6");

const blockedV6 = new net.BlockList();
for (const [base, bits] of [
  ["2001::", 32], // Teredo transition prefix
  ["2001:2::", 48], // benchmarking
  ["2001:10::", 28], ["2001:20::", 28], // ORCHID/ORCHIDv2
  ["2001:db8::", 32], ["2002::", 16], // documentation and 6to4 tunneling
  ["3fff::", 20] // documentation
]) blockedV6.addSubnet(base, bits, "ipv6");

const mappedV4 = new net.BlockList();
mappedV4.addSubnet("::ffff:0:0", 96, "ipv6");

export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return blockedV4.check(address, "ipv4");
  if (family !== 6) return true;
  if (mappedV4.check(address, "ipv6")) return blockedV4.check(address, "ipv6");
  return !globallyRoutableV6.check(address, "ipv6") || blockedV6.check(address, "ipv6");
}
