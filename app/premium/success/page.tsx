"use client"

import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { getCheckoutSession } from "@/app/actions/stripe"
import { createClient } from "@/lib/supabase/client"
import { Crown, Download, Loader2 } from "lucide-react"

export default function PremiumSuccessPage() {
  const searchParams = useSearchParams()
  const sessionId = searchParams.get("session_id")
  const [status, setStatus] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    async function checkSession() {
      if (!sessionId) {
        setIsLoading(false)
        return
      }

      try {
        const session = await getCheckoutSession(sessionId)
        setStatus(session.status)

        if (session.status === "complete") {
          // Actualizar suscripcion en la base de datos
          const {
            data: { user },
          } = await supabase.auth.getUser()

          if (user) {
            await supabase.from("subscriptions").upsert({
              user_id: user.id,
              stripe_subscription_id: sessionId,
              status: "active",
              current_period_start: new Date().toISOString(),
              current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            })
          }
        }
      } catch (error) {
        console.error("Error checking session:", error)
      } finally {
        setIsLoading(false)
      }
    }

    checkSession()
  }, [sessionId, supabase])

  return (
    <div className="flex min-h-screen flex-col">
      <Header />

      <main className="flex-1 container mx-auto px-4 py-16 flex items-center justify-center">
        <Card className="w-full max-w-md gradient-border text-center">
          <CardHeader>
            {isLoading ? (
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : status === "complete" ? (
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent">
                <Crown className="h-8 w-8 text-white" />
              </div>
            ) : (
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                <Crown className="h-8 w-8 text-muted-foreground" />
              </div>
            )}

            <CardTitle className="text-2xl">
              {isLoading
                ? "Procesando..."
                : status === "complete"
                  ? "Bienvenido a Premium"
                  : "Pago pendiente"}
            </CardTitle>
            <CardDescription>
              {isLoading
                ? "Verificando tu pago"
                : status === "complete"
                  ? "Tu suscripcion esta activa"
                  : "Tu pago no se pudo completar"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!isLoading && status === "complete" && (
              <>
                <p className="text-sm text-muted-foreground">
                  Ahora tienes acceso a descargas ilimitadas. Gracias por tu apoyo.
                </p>
                <Link href="/">
                  <Button className="w-full">
                    <Download className="mr-2 h-4 w-4" />
                    Empezar a descargar
                  </Button>
                </Link>
              </>
            )}

            {!isLoading && status !== "complete" && (
              <Link href="/premium">
                <Button className="w-full">Intentar de nuevo</Button>
              </Link>
            )}
          </CardContent>
        </Card>
      </main>

      <Footer />
    </div>
  )
}
