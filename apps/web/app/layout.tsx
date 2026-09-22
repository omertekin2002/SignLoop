import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Inter } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import Providers from "@/components/providers";
import { PrivacyNotice } from "@/components/privacy-notice";
import "./globals.css";

// Dala's typeface is the licensed PPNeueMontreal; Inter is its documented substitute. The variable
// font covers the ultra-light 200 body weight. `--font-ppneuemontreal` in globals.css picks it up.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "SignLoop",
  description: "AI Contract Analysis",
  // Icons come from the app/ file conventions: icon.svg, favicon.ico, apple-icon.png.
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en" className={inter.variable} suppressHydrationWarning>
        <body className="font-sans antialiased bg-background text-foreground">
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
