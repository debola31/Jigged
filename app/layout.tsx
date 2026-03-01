import type { Metadata } from "next";
import { ThemeProvider, AuthProvider } from "@/components/providers";

export const metadata: Metadata = {
  title: "Jigged - Manufacturing ERP",
  description: "Operations system for small manufacturing shops",
  icons: {
    icon: '/icon.svg',
    apple: '/apple-icon.png',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <ThemeProvider>
          <AuthProvider>
            {children}
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
