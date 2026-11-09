import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Tabs } from "@/components/Tabs";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "FynkTech Listing",
  description: "Research products, review the results, and create Shopify drafts.",
  icons: {
    icon: [{ url: "/fynktech-logo.png", type: "image/png" }],
    apple: "/fynktech-logo.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className} suppressHydrationWarning>
        <div className="app-shell">
          <Tabs />
          <main className="app-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
