import type { Metadata, Viewport } from "next";

import { BUZZ_TITLE, BUZZ_TITLE_TEMPLATE } from "@/shared/page-title";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: BUZZ_TITLE,
    template: BUZZ_TITLE_TEMPLATE,
  },
  description: "Server-rendered Buzz messaging",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  initialScale: 1,
  viewportFit: "cover",
  width: "device-width",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
