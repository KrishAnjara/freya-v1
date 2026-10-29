import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self), payment=()" },
];

const nextConfig: NextConfig = {
  distDir: process.env.FREYA_NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  async headers() {
    const headers = [...securityHeaders];
    if (process.env.NODE_ENV === "production") {
      headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000" });
    }
    return [{ source: "/:path*", headers }];
  },
};
export default nextConfig;
