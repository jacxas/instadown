import Link from "next/link"
import { Download } from "lucide-react"

export function Footer() {
  return (
    <footer className="border-t border-border/40 py-8">
      <div className="container mx-auto px-4">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent">
              <Download className="h-4 w-4 text-white" />
            </div>
            <span className="font-semibold gradient-text">InstaDown</span>
          </div>

          <nav className="flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground">
            <Link href="/premium" className="hover:text-foreground transition-colors">
              Premium
            </Link>
            <Link href="/privacy" className="hover:text-foreground transition-colors">
              Privacidad
            </Link>
            <Link href="/terms" className="hover:text-foreground transition-colors">
              Terminos
            </Link>
          </nav>

          <p className="text-sm text-muted-foreground">
            {new Date().getFullYear()} InstaDown. Todos los derechos reservados.
          </p>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          InstaDown no esta afiliado con Instagram o Meta. Usalo responsablemente.
        </p>
      </div>
    </footer>
  )
}
