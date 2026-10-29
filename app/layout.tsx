import type { Metadata, Viewport } from "next";
// @ts-ignore - CSS imports are handled by Next.js
import "./freya.css";

export const metadata: Metadata = {
  title: "FREYA — Adaptive Intelligence",
  description: "A personality-first conversational AI prototype."
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#070a0b",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
