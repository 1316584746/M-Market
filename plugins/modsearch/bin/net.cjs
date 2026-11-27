"use strict";
/**
 * 本地抓取的网络防护（SSRF）。移植自 liustack/modsearch（MIT）的 providers/http/network.ts。
 * 模型会很乐意去抓网页里冒出来的链接，所以主机名黑名单、内网 / 保留地址段和每一跳重定向都要在发请求前检查。
 * 直连时把 socket 钉在检查过的那个 IP 上，DNS 在检查和连接之间变了也指不到没检查过的地址。
 * 198.18.0.0/15 的 DNS 结果是代理（Clash 等）的 fake-IP 占位，放行；写成字面 URL 的仍然拦。
 */
const dns = require("node:dns/promises");
const { isIP } = require("node:net");

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.amazonaws.com",
  "metadata.azure.internal",
]);

function normalizeFetchUrl(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) throw new Error("Fetch URL is required.");
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: ${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http/https URLs are supported.");
  if (parsed.username || parsed.password) throw new Error("URL with embedded credentials is not allowed.");
  return parsed;
}

function isBlockedHostname(hostname) {
  const n = String(hostname || "").trim().toLowerCase();
  if (!n) return true;
  return BLOCKED_HOSTNAMES.has(n) || n.endsWith(".localhost");
}

const stripBrackets = h => (h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h);

function ipv4ToNumber(ip) {
  const o = ip.split(".").map(p => Number.parseInt(p, 10));
  return o[0] * 256 ** 3 + o[1] * 256 ** 2 + o[2] * 256 + o[3];
}
const inRange = (v, a, b) => v >= ipv4ToNumber(a) && v <= ipv4ToNumber(b);

function isPrivateIPv4(ip) {
  const o = ip.split(".").map(p => Number.parseInt(p, 10));
  if (o.length !== 4 || o.some(v => !Number.isFinite(v) || v < 0 || v > 255)) return true;
  const v = ipv4ToNumber(ip);
  return (
    inRange(v, "0.0.0.0", "0.255.255.255") ||
    inRange(v, "10.0.0.0", "10.255.255.255") ||
    inRange(v, "100.64.0.0", "100.127.255.255") ||
    inRange(v, "127.0.0.0", "127.255.255.255") ||
    inRange(v, "169.254.0.0", "169.254.255.255") ||
    inRange(v, "172.16.0.0", "172.31.255.255") ||
    inRange(v, "192.0.0.0", "192.0.0.255") ||
    inRange(v, "192.168.0.0", "192.168.255.255") ||
    inRange(v, "198.18.0.0", "198.19.255.255") ||
    inRange(v, "224.0.0.0", "255.255.255.255")
  );
}

function parseIpv6Groups(groups) {
  if (groups.length !== 8) return null;
  const parsed = groups.map(g => Number.parseInt(g || "0", 16));
  if (parsed.some(v => !Number.isFinite(v) || v < 0 || v > 0xffff)) return null;
  return parsed;
}

function expandIpv6(ip) {
  let value = ip.toLowerCase();
  // 末尾的点分 IPv4（::127.0.0.1、::ffff:1.2.3.4）先换成两组十六进制，否则按十六进制解析会得到错的值
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    if ([a, b, c, d].some(x => x > 255)) return null;
    value = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  if (value.includes("::")) {
    const [left, right] = value.split("::");
    const l = left ? left.split(":").filter(Boolean) : [];
    const r = right ? right.split(":").filter(Boolean) : [];
    if (l.length + r.length > 8) return null;
    return parseIpv6Groups([...l, ...new Array(8 - l.length - r.length).fill("0"), ...r]);
  }
  return parseIpv6Groups(value.split(":"));
}

const ipv6ToBigInt = ip => {
  const g = expandIpv6(ip);
  return g ? g.reduce((acc, x) => (acc << 16n) + BigInt(x), 0n) : null;
};

function inIpv6Range(value, start, prefix) {
  const s = ipv6ToBigInt(start);
  if (s === null) return false;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return (value & mask) === (s & mask);
}

function mappedIpv4(ip) {
  const lower = ip.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const c = lower.slice(7);
  return isIP(c) === 4 ? c : null;
}

function v4FromGroups(g) {
  return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".");
}

function isPrivateIPv6(ip) {
  const g = expandIpv6(ip);
  // ::ffff:127.0.0.1 规范化后是 ::ffff:7f00:1，按 IPv6 判会把回环放过去
  if (g && g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return isPrivateIPv4(v4FromGroups(g));
  // 把 IPv4 嵌在 IPv6 里的几种形式：NAT64（64:ff9b::/96）、IPv4 兼容（::/96）、IPv4 翻译（::ffff:0:0:0/96）、6to4（2002::/16）。
  // 内网 / 元数据地址（例如 169.254.169.254）换个写法就能绕过上面的 IPv4 检查，所以取出嵌入的 IPv4 再查一遍
  if (g) {
    const tail = v4FromGroups(g);
    if (g.slice(0, 6).every(x => x === 0)) return isPrivateIPv4(tail);
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isPrivateIPv4(tail);
    if (g.slice(0, 4).every(x => x === 0) && g[4] === 0xffff && g[5] === 0) return isPrivateIPv4(tail);
    if (g[0] === 0x2002) return isPrivateIPv4([g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff].join("."));
    if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
    if (g[0] === 0x100 && g.slice(1, 4).every(x => x === 0)) return true; // 丢弃前缀 100::/64
    if ((g[0] & 0xffc0) === 0xfec0) return true; // 已弃用的站点本地 fec0::/10
  }
  const norm = ip.split("%")[0];
  const m = mappedIpv4(norm);
  if (m && isPrivateIPv4(m)) return true;
  const v = ipv6ToBigInt(norm);
  if (v === null) return true;
  return inIpv6Range(v, "::", 128) || inIpv6Range(v, "::1", 128) || inIpv6Range(v, "fc00::", 7) || inIpv6Range(v, "fe80::", 10) || inIpv6Range(v, "ff00::", 8) || inIpv6Range(v, "2001:db8::", 32);
}

function isPrivateIpAddress(ip) {
  const n = String(ip || "").trim().toLowerCase();
  const f = isIP(n);
  if (f === 4) return isPrivateIPv4(n);
  if (f === 6) return isPrivateIPv6(n);
  return true;
}

function isLoopbackIpAddress(ip) {
  const n = String(ip || "").trim().toLowerCase();
  const f = isIP(n);
  if (f === 4) return inRange(ipv4ToNumber(n), "127.0.0.0", "127.255.255.255");
  if (f === 6) {
    const g = expandIpv6(n);
    if (g && g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return inRange(ipv4ToNumber(v4FromGroups(g)), "127.0.0.0", "127.255.255.255");
    const m = mappedIpv4(n.split("%")[0]);
    if (m) return inRange(ipv4ToNumber(m), "127.0.0.0", "127.255.255.255");
    const v = ipv6ToBigInt(n.split("%")[0]);
    return v !== null && inIpv6Range(v, "::1", 128);
  }
  return false;
}

const isFakeIpPoolAddress = ip => isIP(ip) === 4 && inRange(ipv4ToNumber(ip), "198.18.0.0", "198.19.255.255");
const isPrivateForCloudDisclosure = ip => !isFakeIpPoolAddress(ip) && isPrivateIpAddress(ip);

/** 解析全部地址；超时就放弃等待（系统解析器取消不了，但调用方的期限照样生效） */
async function lookupAll(hostname, signal) {
  if (!signal) return dns.lookup(hostname, { all: true, verbatim: true });
  signal.throwIfAborted();
  const lookup = dns.lookup(hostname, { all: true, verbatim: true });
  lookup.catch(() => {});
  let onAbort = () => {};
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([lookup, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

const PRIVATE_HINT = "在设置里打开「允许访问内网地址」，只在你确认需要时才开";

function privateBlockMessage(hostname, resolved) {
  const target = resolved ? `${hostname} -> ${resolved}` : hostname;
  const ip = resolved || hostname;
  if (isLoopbackIpAddress(ip)) {
    return `Blocked private network target: ${target}. 如果本机的 VPN / 代理把公网域名映射进了保留地址段（198.18.0.0/15 的 fake-IP 池除外），或 hosts 加速器（如 Watt Toolkit / Steam++）把公网域名指向了 127.0.0.1，${PRIVATE_HINT}。`;
  }
  return `Blocked private network target: ${target}. 如果本机的 VPN / 代理把公网域名映射进了保留地址段（198.18.0.0/15 的 fake-IP 池除外），${PRIVATE_HINT}。`;
}

/** 校验一跳目标，返回通过检查的那个 IP；直连路径要把 socket 钉在它上面 */
async function assertSafeRemoteTarget(url, allowPrivateNetwork, signal) {
  if (isBlockedHostname(url.hostname)) throw new Error(`Blocked hostname: ${url.hostname}`);
  const hostname = stripBrackets(url.hostname);
  const family = isIP(hostname);
  if (family > 0) {
    if (!allowPrivateNetwork && isPrivateIpAddress(hostname)) {
      if (isLoopbackIpAddress(hostname)) throw new Error(privateBlockMessage(hostname));
      throw new Error(`Blocked private network target: ${hostname}`);
    }
    return { hostname, address: hostname, family };
  }
  let resolved;
  try {
    resolved = await lookupAll(hostname, signal);
  } catch (e) {
    if (signal && signal.aborted) throw signal.reason;
    throw new Error(`DNS lookup failed for host ${hostname}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!resolved.length) throw new Error(`Host ${hostname} did not resolve to any IP address.`);
  if (!allowPrivateNetwork) {
    const blocked = resolved.find(r => !isFakeIpPoolAddress(r.address) && isPrivateIpAddress(r.address));
    if (blocked) throw new Error(privateBlockMessage(hostname, blocked.address));
  }
  const [chosen] = resolved;
  return { hostname, address: chosen.address, family: chosen.family };
}

/** 字面上就是内网 / 保留目标：这类地址不能交给云端抓取，否则会把内网地址泄露出去 */
function isLiteralReservedTarget(url) {
  if (isBlockedHostname(url.hostname)) return true;
  const h = stripBrackets(url.hostname).trim().toLowerCase();
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (isIP(h) > 0) return isPrivateIpAddress(h);
  return false;
}

async function inspectCloudDisclosureTarget(url, signal) {
  if (isBlockedHostname(url.hostname)) return { reserved: true, addresses: [] };
  const hostname = stripBrackets(url.hostname);
  if (isIP(hostname) > 0) return { reserved: isPrivateIpAddress(hostname), addresses: [hostname] };
  try {
    const resolved = await lookupAll(hostname, signal);
    const addresses = resolved.map(r => r.address);
    return { reserved: addresses.length > 0 && addresses.every(a => isPrivateForCloudDisclosure(a)), addresses };
  } catch {
    if (signal && signal.aborted) throw signal.reason;
    // 从这里证明不了它是内网，就不拦云端引擎
    return { reserved: false, addresses: [] };
  }
}

/** 云端抓取引擎（firecrawl、keenable）发 URL 之前都要过这一关 */
async function assertCloudDisclosable(engineName, target, deadline, timeoutMs) {
  if (isLiteralReservedTarget(target)) throw new Error(`${engineName} does not fetch the private or reserved target ${target.hostname}. Use the local engine instead.`);
  let d;
  try {
    d = await inspectCloudDisclosureTarget(target, deadline);
  } catch (e) {
    if (deadline.aborted) throw new Error(`${engineName} timed out after ${timeoutMs} ms.`);
    throw e;
  }
  if (d.reserved) {
    const resolved = d.addresses.length ? ` -> ${d.addresses.join(", ")}` : "";
    throw new Error(`${engineName} does not fetch the private or reserved target ${target.hostname}${resolved}. 如果本机用了 fake-IP 式 DNS，公网域名在这里可能看起来像保留地址。Use the local engine instead.`);
  }
}

module.exports = { normalizeFetchUrl, isBlockedHostname, isPrivateIpAddress, assertSafeRemoteTarget, assertCloudDisclosable, isLiteralReservedTarget };
