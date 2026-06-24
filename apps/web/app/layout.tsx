import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Inter, EB_Garamond } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import Providers from "@/components/providers";
import { PrivacyNotice } from "@/components/privacy-notice";
import "katex/dist/katex.min.css";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

const ebGaramond = EB_Garamond({
  subsets: ["latin"],
  variable: "--font-eb-garamond",
});

export const metadata: Metadata = {
  title: "SignLoop",
  description: "AI Contract Analysis",
  icons: {
    icon: [{ url: "/favicon.png", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${inter.variable} ${ebGaramond.variable}`} suppressHydrationWarning>
        <body className="font-sans antialiased bg-background text-foreground dark:selection:bg-white/20 selection:bg-black/10">
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
