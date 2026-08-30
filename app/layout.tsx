import type { Metadata, Viewport } from "next";
import { Noto_Serif_SC, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const serif = Noto_Serif_SC({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-serif", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Plate · zmzai.cloud",
  description: "代码执行与 Agent 实验的沙箱 · zmzai.cloud 子产品",
};

export const viewport: Viewport = { themeColor: "#FFFFFF" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={`${serif.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
