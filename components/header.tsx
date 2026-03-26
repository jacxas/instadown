"use client"

import Link from "next/link"
import { Button } from "./ui/button"
import { Download, User, LogOut, Crown } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { useRouter } from "next/navigation"
import useSWR from "swr"

export function Header() {
  const router = useRouter()
  const supabase = createClient()

  const { data: session, mutate } = useSWR("session", async () => {
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

  const handleLogout = async () => {
    await supabase.auth.signOut()
    mutate(null)
    router.refresh()
  }

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 glass">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent">
            <Download className="h-5 w-5 text-white" />
          </div>
          <span className="text-xl font-bold gradient-text">InstaDown</span>
        </Link>

        <nav className="flex items-center gap-3">
          {session ? (
            <>
              {subscription ? (
                <div className="hidden sm:flex items-center gap-1.5 rounded-full bg-gradient-to-r from-primary/20 to-accent/20 px-3 py-1.5 text-sm font-medium text-primary">
                  <Crown className="h-4 w-4" />
                  Premium
                </div>
              ) : (
                <Link href="/premium">
                  <Button variant="outline" size="sm" className="hidden sm:flex">
                    <Crown className="mr-2 h-4 w-4" />
                    Hazte Premium
                  </Button>
                </Link>
              )}
              <Link href="/dashboard">
                <Button variant="ghost" size="icon">
                  <User className="h-5 w-5" />
                </Button>
              </Link>
              <Button variant="ghost" size="icon" onClick={handleLogout}>
                <LogOut className="h-5 w-5" />
              </Button>
            </>
          ) : (
            <>
              <Link href="/auth/login">
                <Button variant="ghost" size="sm">
                  Iniciar sesion
                </Button>
              </Link>
              <Link href="/auth/sign-up">
                <Button size="sm">Registrarse</Button>
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  )
}
