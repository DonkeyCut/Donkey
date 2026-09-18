import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import { QueryProvider } from "@/queries/QueryProvider";
import { PostHogProvider } from "./_components/PostHogProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // The base every relative card and canonical URL resolves against. Left
  // unset, Next reads the request's own host to resolve them, which makes the
  // metadata of an otherwise static page request-dependent.
  metadataBase: new URL(DONKEYCUT_CANONICAL),
  title: "Donkey Cut",
  description: "A video editor that does all its work on your Mac.",
  // Declared here and served from public/ at these URLs. File-based icons —
  // favicon.ico and apple-icon.png sitting in app/ — resolve per request, which
  // makes the metadata of every page in the app request-dependent and holds
  // back its static shell.
  //
  // Every icon here is the black and white mark, and the 192px PNG is the size
  // Google's favicon crawler asks for, so the icon it picks for a search result
  // is the one we ship. The blue rounded-square icon belongs to the Mac app.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/icon.png", type: "image/png", sizes: "192x192" },
    ],
    apple: "/apple-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <PostHogProvider>
          <QueryProvider>{children}</QueryProvider>
        </PostHogProvider>
      </body>
    </html>
  );
}
