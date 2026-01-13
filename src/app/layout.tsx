import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Code-Auto",
  description: "Autonomous AI agents for developers",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
