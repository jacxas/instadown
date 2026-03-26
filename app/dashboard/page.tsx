"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { createClient } from "@/lib/supabase/client"
import useSWR from "swr"
import { Crown, Download, Calendar, Image, Film, Play, Clock, UserCircle, Star, ArrowRight } from "lucide-react"
import { FREE_DAILY_LIMIT } from "@/lib/products"

const CONTENT_TYPE_ICONS: Record<string, typeof Image> = {
  photo: Image,
  video: Film,
  reel: Play,
  story: Clock,
  profile: UserCircle,
  highlights: Star,
}

const CONTENT_TYPE_LABELS: Record<string, string> = {
  photo: "Foto",
  video: "Video",
  reel: "Reel",
  story: "Historia",
  profile: "Foto de perfil",
  highlights: "Destacado",
}

export default function DashboardPage() {
  const router = useRouter()
  const supabase = createClient()

  const { data: session, isLoading: sessionLoading } = useSWR("session", async () => {
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

  const { data: downloads } = useSWR(
    session ? `downloads-${session.id}` : null,
    async () => {
      const { data } = await supabase
        .from("downloads")
        .select("*")
        .eq("user_id", session!.id)
        .order("created_at", { ascending: false })
        .limit(10)
      return data || []
    }
  )

  const { data: stats } = useSWR(
    session ? `stats-${session.id}` : null,
    async () => {
      const { count: totalDownloads } = await supabase
        .from("downloads")
        .select("*", { count: "exact", head: true })
        .eq("user_id", session!.id)

      const today = new Date().toISOString().split("T")[0]
      const { count: todayDownloads } = await supabase
        .from("downloads")
        .select("*", { count: "exact", head: true })
        .eq("user_id", session!.id)
        .gte("created_at", `${today}T00:00:00`)

      return {
        total: totalDownloads || 0,
        today: todayDownloads || 0,
      }
    }
  )

  useEffect(() => {
    if (!sessionLoading && !session) {
      router.push("/auth/login")
    }
  }, [session, sessionLoading, router])

  if (sessionLoading || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  const isPremium = !!subscription

  return (
    <div className="flex min-h-screen flex-col">
      <Header />

      <main className="flex-1 container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Mi cuenta</h1>
          <p className="text-muted-foreground">{session.email}</p>
        </div>

        <div className="grid gap-6 md:grid-cols-3 mb-8">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Plan actual</CardDescription>
              <CardTitle className="flex items-center gap-2">
                {isPremium ? (
                  <>
                    <Crown className="h-5 w-5 text-primary" />
                    Premium
                  </>
                ) : (
                  "Gratuito"
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isPremium ? (
                <p className="text-sm text-muted-foreground">Descargas ilimitadas</p>
              ) : (
                <Link href="/premium">
                  <Button size="sm" className="mt-2">
                    Mejorar plan
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </Link>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Descargas hoy</CardDescription>
              <CardTitle className="flex items-center gap-2">
                <Download className="h-5 w-5 text-primary" />
                {stats?.today || 0} {!isPremium && `/ ${FREE_DAILY_LIMIT}`}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {isPremium ? "Sin limite" : `${Math.max(0, FREE_DAILY_LIMIT - (stats?.today || 0))} restantes`}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total descargas</CardDescription>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5 text-primary" />
                {stats?.total || 0}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Desde que te registraste</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Historial de descargas</CardTitle>
            <CardDescription>Tus ultimas 10 descargas</CardDescription>
          </CardHeader>
          <CardContent>
            {downloads && downloads.length > 0 ? (
              <div className="space-y-3">
                {downloads.map((download) => {
                  const Icon = CONTENT_TYPE_ICONS[download.content_type] || Download
                  const label = CONTENT_TYPE_LABELS[download.content_type] || download.content_type

                  return (
                    <div
                      key={download.id}
                      className="flex items-center gap-4 rounded-lg border p-3"
                    >
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                        <Icon className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{label}</p>
                        <p className="text-xs text-muted-foreground truncate">{download.url}</p>
                      </div>
                      <p className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(download.created_at).toLocaleDateString("es-ES", {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="text-center py-8">
                <Download className="mx-auto h-12 w-12 text-muted-foreground/50 mb-3" />
                <p className="text-muted-foreground">Aun no has realizado ninguna descarga</p>
                <Link href="/">
                  <Button variant="outline" className="mt-4">
                    Ir a descargar
                  </Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      <Footer />
    </div>
  )
}
