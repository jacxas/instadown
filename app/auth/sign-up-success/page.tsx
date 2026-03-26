import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Download, Mail } from "lucide-react"

export default function SignUpSuccessPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md gradient-border text-center">
        <CardHeader>
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-accent/20">
            <Mail className="h-8 w-8 text-primary" />
          </div>
          <CardTitle className="text-2xl">Revisa tu email</CardTitle>
          <CardDescription>
            Te hemos enviado un enlace de confirmacion a tu correo electronico
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Haz clic en el enlace del email para activar tu cuenta y empezar a descargar contenido de Instagram.
          </p>

          <div className="rounded-lg bg-muted p-4">
            <p className="text-sm text-muted-foreground">
              No ves el email? Revisa tu carpeta de spam o correo no deseado.
            </p>
          </div>

          <Link href="/" className="block">
            <Button variant="outline" className="w-full">
              <Download className="mr-2 h-4 w-4" />
              Volver al inicio
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
