import type { Metadata, Viewport } from "next"
import { Inter } from "next/font/google"
import "./globals.css"

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
})

export const metadata: Metadata = {
  title: "InstaDown - Descarga contenido de Instagram gratis",
  description:
    "Descarga fotos, videos, reels, historias y mas de Instagram de forma rapida y segura. Plan gratuito con 2 descargas diarias o Premium ilimitado por solo $0.25/mes.",
  keywords: ["instagram", "descargar", "fotos", "videos", "reels", "historias", "gratis"],
  authors: [{ name: "InstaDown" }],
  openGraph: {
    title: "InstaDown - Descarga contenido de Instagram",
    description: "Descarga fotos, videos, reels e historias de Instagram facilmente",
    type: "website",
  },
}

export const viewport: Viewport = {
  themeColor: "#e91e8c",
  width: "device-width",
  initialScale: 1,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="es" className="dark">
      <body className={`${inter.variable} font-sans antialiased`}>{children}</body>
    </html>
  )
}
