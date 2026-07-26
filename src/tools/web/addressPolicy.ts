/**
 * 出网目标地址校验模块。
 *
 * `web_fetch` 的 URL 是模型给的，等于把一个任意出网请求交到模型手上。没有这道校验，它
 * 就成了打进本机和内网的入口：`http://localhost:*` 的开发服务、`169.254.169.254` 的云
 * 元数据服务（里面通常有实例凭证）、`10./172.16./192.168.` 的内网服务。
 *
 * 做法是先解析域名再逐个校验解析出的 IP，而不是只看域名字面 —— 否则一个解析到
 * 127.0.0.1 的公网域名就能绕过去。
 *
 * 残留风险（不假装解决）：校验和真正建连之间存在 DNS 重绑定窗口。彻底堵住需要按已校验
 * 的 IP 建连并自带 Host/SNI，那会绕开标准 fetch 的证书校验路径，代价更大。当前实现挡住
 * 的是误用和模型自己想出来的内网地址，不是有针对性的主动攻击。
 */
import { lookup } from "node:dns/promises";
import net from "node:net";

export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedAddressError";
  }
}

export interface AddressPolicy {
  /** 放开私网/环回校验。只应在用户明确为本地服务开启时使用。 */
  allowPrivateNetwork?: boolean;
}

export async function assertFetchableUrl(url: URL, policy: AddressPolicy = {}): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedAddressError(`Only http and https URLs can be fetched: ${url.protocol}//`);
  }
  if (url.username || url.password) {
    throw new BlockedAddressError("URLs carrying inline credentials are refused.");
  }
  if (policy.allowPrivateNetwork) return;

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(hostname)
    ? [hostname]
    : (await lookup(hostname, { all: true })).map((entry) => entry.address);
  if (!addresses.length) throw new BlockedAddressError(`Host did not resolve: ${url.hostname}`);
  for (const address of addresses) {
    const reason = blockedAddressReason(address);
    if (reason) throw new BlockedAddressError(`Refused to fetch ${url.hostname}: it resolves to ${address}, ${reason}.`);
  }
}

export function blockedAddressReason(address: string): string | undefined {
  const version = net.isIP(address);
  if (version === 4) return blockedIpv4Reason(address);
  if (version === 6) return blockedIpv6Reason(address);
  return "which is not a valid IP address";
}

function blockedIpv4Reason(address: string): string | undefined {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  const [a = 0, b = 0] = octets;
  if (a === 0) return "an unspecified address";
  if (a === 127) return "a loopback address";
  if (a === 10) return "a private network address";
  if (a === 172 && b >= 16 && b <= 31) return "a private network address";
  if (a === 192 && b === 168) return "a private network address";
  if (a === 169 && b === 254) return "a link-local address (cloud instance metadata lives here)";
  if (a === 100 && b >= 64 && b <= 127) return "a carrier-grade NAT address";
  if (a === 192 && b === 0) return "a reserved address";
  if (a >= 224) return "a multicast or reserved address";
  return undefined;
}

function blockedIpv6Reason(address: string): string | undefined {
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::0") return "an unspecified address";
  if (lower === "::1") return "a loopback address";
  // IPv4-mapped（::ffff:127.0.0.1）必须按内嵌的 v4 地址判定，否则是条绕过通道。
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return blockedIpv4Reason(mapped[1]);
  if (/^f[cd]/.test(lower)) return "a unique local address";
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return "a link-local address";
  }
  if (lower.startsWith("ff")) return "a multicast address";
  return undefined;
}
