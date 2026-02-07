import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { EB_Garamond } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import Providers from "@/components/providers";
import "./globals.css";

const ebGaramond = EB_Garamond({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-eb-garamond",
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
      <html lang="en" className={ebGaramond.variable} suppressHydrationWarning>
        <body className="font-sans antialiased">
          <div id="dynamic-bg" aria-hidden="true">
            <div className="grid-layer" />
            <div className="noise-layer" />
          </div>
          <Providers>
            <div className="relative z-10">
              {children}
              <Toaster />
            </div>
          </Providers>
        </body>
      </html>
    </ClerkProvider>
  );
}
