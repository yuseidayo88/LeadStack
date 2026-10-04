import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: { default: "LeadStack", template: "%s | LeadStack" },
  description: "企業との関係を育て、次の営業アクションにつなげる CRM。",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
