import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { Toaster } from "@/components/ui/sonner";

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
      <body className="antialiased flex" style={{ background: 'var(--color-background)', color: 'var(--color-foreground)' }}>
        <ThemeProvider>
          <Sidebar />
          <main className="flex-1 overflow-hidden">{children}</main>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
