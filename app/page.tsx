import { Header } from "@/components/header"
import { DownloadForm } from "@/components/download-form"
import { Features } from "@/components/features"
import { Footer } from "@/components/footer"
import { Sparkles } from "lucide-react"

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />

      <main className="flex-1">
        <section className="container mx-auto px-4 py-16 md:py-24">
          <div className="mx-auto max-w-3xl text-center mb-12">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-primary/20 to-accent/20 px-4 py-2 text-sm font-medium text-primary">
              <Sparkles className="h-4 w-4" />
              Descarga gratis fotos, videos y mas
            </div>

            <h1 className="mb-6 text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl text-balance">
              Descarga contenido de{" "}
              <span className="gradient-text">Instagram</span> facilmente
            </h1>

            <p className="mb-8 text-lg text-muted-foreground text-pretty">
              Fotos, videos, reels, historias, fotos de perfil y destacados. Todo en un solo lugar, rapido y seguro.
              Gratis con 2 descargas diarias o Premium ilimitado por $0.25/mes.
            </p>
          </div>

          <div className="mx-auto max-w-2xl">
            <DownloadForm />
          </div>
        </section>

        <section className="container mx-auto px-4">
          <Features />
        </section>
      </main>

      <Footer />
    </div>
  )
}
