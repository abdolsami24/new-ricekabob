import type { Metadata, Viewport } from "next";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import TopNav from "@/components/TopNav";

export const metadata: Metadata = {
  title: "Madinah Market — Halal Kabobs in Aurora, CO",
  description:
    "Madinah Market — Aurora, Colorado · 100% halal. Fire-grilled kabobs, fresh bread and saffron rice. Order pickup or delivery online. 3126 S Parker Rd, Aurora, CO. Call 720-763-0786.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f2b4c",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TopNav />
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
