import type { Metadata } from "next";
import { Tabs } from "@/components/Tabs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Product Listing Assistant",
  description: "Research products, review the results, and create Shopify drafts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="app-header">
          <div className="app-header-inner">
            <span className="app-title">Product Listing Assistant</span>
            <Tabs />
          </div>
        </header>
        <main className="app-main">{children}</main>
      </body>
    </html>
  );
}
