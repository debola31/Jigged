import type { Metadata } from "next";
import { DM_Sans, Space_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { ThemeProvider, AuthProvider } from "@/components/providers";

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-dm-sans",
});

const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-space-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL('https://jigged.app'),
  title: {
    template: '%s | Jigged',
    default: 'Jigged — Manufacturing Operations System',
  },
  description:
    'Replace your rigid legacy ERP with a flexible operations system built for small precision manufacturing shops. Real-time visibility, flexible inventory, and operators who actually log their work.',
  icons: {
    icon: '/icon.svg',
    apple: '/apple-icon.png',
  },
  openGraph: {
    title: 'Jigged — Manufacturing Operations System',
    description:
      'The operations system built for small manufacturing shops. Track jobs, manage inventory, and empower your operators.',
    url: 'https://jigged.app',
    siteName: 'Jigged',
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Jigged — Manufacturing Operations System',
    description:
      'The operations system built for small manufacturing shops. Track jobs, manage inventory, and empower your operators.',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${dmSans.variable} ${spaceMono.variable}`}>
      <body>
        <ThemeProvider>
          <AuthProvider>
            {children}
          </AuthProvider>
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  );
}
