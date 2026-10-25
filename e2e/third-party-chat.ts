/** 回归用：页面不得向这些第三方聊天域名发请求。 */
export const THIRD_PARTY_CHAT_HOSTS = [
  'tawk.to',
  'crisp.chat',
  'intercom.io',
  'intercomcdn.com',
  'tidio.co',
  'tidiochat.com',
  'livechatinc.com',
  'zdassets.com',
  'zopim.com',
] as const;

export function isThirdPartyChatUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return THIRD_PARTY_CHAT_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function thirdPartyChatDomSelector(): string {
  const parts = ['script#tawk-js'];
  for (const domain of THIRD_PARTY_CHAT_HOSTS) {
    parts.push(`script[src*="${domain}"]`, `iframe[src*="${domain}"]`);
  }
  return parts.join(', ');
}
