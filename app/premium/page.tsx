"use client"

import { useState } from "react"
import Link from "next/link"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkout } from "@/components/checkout"
import { PRODUCTS } from "@/lib/products"
import { Check, Crown, ArrowLeft, Sparkles } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import useSWR from "swr"

export default function PremiumPage() {
  const [showCheckout, setShowCheckout] = useState(false)
  const product = PRODUCTS[0]
  const supabase = createClient()

  const { data: session } = useSWR("session", async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser()
    return user
  })

  const { data: subscription } = useSWR(
    session ? `subscription-${session.id}` : null,
    async () => {
      const { data } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("user_id", session!.id)
        .eq("status", "active")
        .single()
      return data
    }
  )

  if (subscription) {
    return (
      <div className="flex min-h-screen flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-16">
          <Card className="mx-auto max-w-md gradient-border text-center">
            <CardHeader>
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent">
                <Crown className="h-8 w-8 text-white" />
              </div>
              <CardTitle className="text-2xl">Ya eres Premium</CardTitle>
              <CardDescription>Disfruta de descargas ilimitadas</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/">
                <Button className="w-full">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Ir a descargar
                </Button>
              </Link>
            </CardContent>
          </Card>
        </main>
        <Footer />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header />

      <main className="flex-1 container mx-auto px-4 py-16">
        <div className="mx-auto max-w-2xl text-center mb-12">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-primary/20 to-accent/20 px-4 py-2 text-sm font-medium text-primary">
            <Sparkles className="h-4 w-4" />
            Oferta especial
          </div>
          <h1 className="text-4xl font-bold mb-4 text-balance">
            Hazte <span className="gradient-text">Premium</span>
          </h1>
          <p className="text-lg text-muted-foreground text-pretty">
            Descargas ilimitadas por menos de lo que cuesta un cafe
          </p>
        </div>

        {!showCheckout ? (
          <Card className="mx-auto max-w-md gradient-border">
            <CardHeader className="text-center">
              <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-primary to-accent">
                <Crown className="h-7 w-7 text-white" />
              </div>
              <CardTitle className="text-2xl">{product.name}</CardTitle>
              <CardDescription>{product.description}</CardDescription>
              <div className="mt-4">
                <span className="text-4xl font-bold">${(product.priceInCents / 100).toFixed(2)}</span>
                <span className="text-muted-foreground">/mes</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <ul className="space-y-3">
                {product.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-3">
                    <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/20">
                      <Check className="h-3 w-3 text-primary" />
                    </div>
                    <span className="text-sm">{feature}</span>
                  </li>
                ))}
              </ul>

              {session ? (
                <Button className="w-full" size="lg" onClick={() => setShowCheckout(true)}>
                  <Crown className="mr-2 h-4 w-4" />
                  Suscribirme ahora
                </Button>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-center text-muted-foreground">
                    Inicia sesion para suscribirte
                  </p>
                  <Link href="/auth/login">
                    <Button className="w-full" size="lg">
                      Iniciar sesion
                    </Button>
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="mx-auto max-w-lg">
            <Button variant="ghost" className="mb-4" onClick={() => setShowCheckout(false)}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Volver
            </Button>
            <Checkout productId={product.id} />
          </div>
        )}
      </main>

      <Footer />
    </div>
  )
}
