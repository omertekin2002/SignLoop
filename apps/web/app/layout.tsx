import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Fraunces, Space_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import Providers from "@/components/providers";
import { PrivacyNotice } from "@/components/privacy-notice";
import "katex/dist/katex.min.css";
import "./globals.css";

const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
  variable: "--font-space-mono",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-fraunces",
});

export const metadata: Metadata = {
  title: "SignLoop",
  description: "AI Contract Analysis",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${spaceMono.variable} ${fraunces.variable}`} suppressHydrationWarning>
        <body className="font-sans antialiased">
          <div id="dynamic-bg" aria-hidden="true">
            <div className="bg-layer aurora-layer" />
            <div className="bg-layer glow-orb orb-a" />
            <div className="bg-layer glow-orb orb-b" />
            <div className="bg-layer glow-orb orb-c" />
            <div className="grid-layer" />
            <div className="noise-layer" />
          </div>
          <Providers>
            <div className="relative z-10">
              {children}
              <PrivacyNotice />
              <Toaster />
            </div>
          </Providers>
        </body>
      </html>
    </ClerkProvider>
  );
}
