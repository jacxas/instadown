"use client"

import { useState } from "react"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { Card, CardContent } from "./ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs"
import { Download, Image, Film, Clock, Play, UserCircle, Star, AlertCircle } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import useSWR from "swr"
import Link from "next/link"
import { FREE_DAILY_LIMIT } from "@/lib/products"

const DOWNLOAD_TYPES = [
  { id: "photo", label: "Foto", icon: Image, placeholder: "https://instagram.com/p/..." },
  { id: "video", label: "Video", icon: Film, placeholder: "https://instagram.com/p/..." },
  { id: "reel", label: "Reel", icon: Play, placeholder: "https://instagram.com/reel/..." },
  { id: "story", label: "Historia", icon: Clock, placeholder: "https://instagram.com/stories/usuario/..." },
  { id: "profile", label: "Foto de perfil", icon: UserCircle, placeholder: "nombre_de_usuario" },
  { id: "highlights", label: "Destacados", icon: Star, placeholder: "https://instagram.com/stories/highlights/..." },
]

export function DownloadForm() {
  const [url, setUrl] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

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

  const { data: todayDownloads, mutate: mutateDownloads } = useSWR(
    session ? `downloads-today-${session.id}` : null,
    async () => {
      const today = new Date().toISOString().split("T")[0]
      const { count } = await supabase
        .from("downloads")
        .select("*", { count: "exact", head: true })
        .eq("user_id", session!.id)
        .gte("created_at", `${today}T00:00:00`)
      return count || 0
    }
  )

  const isPremium = !!subscription
  const remainingDownloads = isPremium ? Infinity : FREE_DAILY_LIMIT - (todayDownloads || 0)
  const canDownload = isPremium || remainingDownloads > 0

  const handleDownload = async (type: string) => {
    if (!url.trim()) {
      setError("Por favor, introduce una URL o nombre de usuario")
      return
    }

    if (!session) {
      setError("Debes iniciar sesion para descargar")
      return
    }

    if (!canDownload) {
      setError("Has alcanzado el limite diario. Hazte Premium para descargas ilimitadas.")
      return
    }

    setIsLoading(true)
    setError(null)
    setSuccess(null)

    try {
      // Registrar la descarga en la base de datos
      const { error: insertError } = await supabase.from("downloads").insert({
        user_id: session.id,
        content_type: type,
        url: url,
      })

      if (insertError) throw insertError

      // Redirigir a FastDL para la descarga real
      const fastDlUrl = `https://fastdl.app/es?url=${encodeURIComponent(url)}`
      window.open(fastDlUrl, "_blank")

      setSuccess("Descarga iniciada correctamente")
      setUrl("")
      mutateDownloads()
    } catch (err) {
      setError("Error al procesar la descarga. Intenta de nuevo.")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Card className="gradient-border overflow-hidden">
      <CardContent className="p-6">
        <Tabs defaultValue="photo" className="w-full">
          <TabsList className="mb-6 w-full justify-start overflow-x-auto">
            {DOWNLOAD_TYPES.map((type) => (
              <TabsTrigger key={type.id} value={type.id} className="gap-2">
                <type.icon className="h-4 w-4" />
                <span className="hidden sm:inline">{type.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>

          {DOWNLOAD_TYPES.map((type) => (
            <TabsContent key={type.id} value={type.id}>
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row gap-3">
                  <Input
                    placeholder={type.placeholder}
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    className="flex-1"
                    disabled={isLoading}
                  />
                  <Button onClick={() => handleDownload(type.id)} disabled={isLoading || !canDownload} isLoading={isLoading}>
                    <Download className="mr-2 h-4 w-4" />
                    Descargar
                  </Button>
                </div>

                {error && (
                  <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4 flex-shrink-0" />
                    {error}
                  </div>
                )}

                {success && (
                  <div className="flex items-center gap-2 rounded-lg bg-green-500/10 p-3 text-sm text-green-500">
                    <Download className="h-4 w-4 flex-shrink-0" />
                    {success}
                  </div>
                )}

                {session && !isPremium && (
                  <div className="flex items-center justify-between rounded-lg bg-muted p-3">
                    <span className="text-sm text-muted-foreground">
                      Descargas restantes hoy: <strong className="text-foreground">{Math.max(0, remainingDownloads)}</strong> / {FREE_DAILY_LIMIT}
                    </span>
                    <Link href="/premium">
                      <Button variant="outline" size="sm">
                        Obtener ilimitadas
                      </Button>
                    </Link>
                  </div>
                )}

                {!session && (
                  <div className="flex items-center justify-between rounded-lg bg-muted p-3">
                    <span className="text-sm text-muted-foreground">Inicia sesion para empezar a descargar</span>
                    <Link href="/auth/login">
                      <Button variant="outline" size="sm">
                        Iniciar sesion
                      </Button>
                    </Link>
                  </div>
                )}
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  )
}
