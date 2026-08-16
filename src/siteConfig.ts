export const siteConfig = {
  name: "Stockpulse",
  domain: "stockpulse.com.cn",
  url: "https://stockpulse.com.cn",
  description: "个人公开信息整理与研究记录工具",
  filing: {
    icpNumber: "粤ICP备2026023302号-1",
    icpUrl: "https://beian.miit.gov.cn/"
  },
  publicSecurity: {
    number: "",
    recordCode: "",
    iconPath: ""
  }
} as const;

export function publicSecurityFilingUrl(recordCode: string) {
  return `https://beian.mps.gov.cn/#/query/webSearch?code=${encodeURIComponent(recordCode)}`;
}
