import { Card, CardContent } from "./ui/card"
import { Zap, Shield, Smartphone, Clock, Download, Crown } from "lucide-react"

const features = [
  {
    icon: Zap,
    title: "Ultra rapido",
    description: "Descarga contenido en segundos con nuestra tecnologia optimizada",
  },
  {
    icon: Shield,
    title: "100% Seguro",
    description: "No almacenamos tus datos ni credenciales de Instagram",
  },
  {
    icon: Smartphone,
    title: "Multiplataforma",
    description: "Funciona en cualquier dispositivo con navegador web",
  },
  {
    icon: Clock,
    title: "Sin limites de tiempo",
    description: "Descarga historias y destacados sin importar su antiguedad",
  },
  {
    icon: Download,
    title: "Alta calidad",
    description: "Obtiene el contenido en su resolucion original",
  },
  {
    icon: Crown,
    title: "Plan Premium",
    description: "Descargas ilimitadas por solo $0.25 al mes",
  },
]

export function Features() {
  return (
    <section className="py-16">
      <div className="text-center mb-12">
        <h2 className="text-3xl font-bold mb-4 text-balance">
          Por que elegir <span className="gradient-text">InstaDown</span>
        </h2>
        <p className="text-muted-foreground max-w-2xl mx-auto text-pretty">
          La forma mas facil y rapida de descargar contenido de Instagram
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <Card key={feature.title} className="group hover:border-primary/50 transition-colors">
            <CardContent className="p-6">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br from-primary/20 to-accent/20 group-hover:from-primary/30 group-hover:to-accent/30 transition-colors">
                <feature.icon className="h-6 w-6 text-primary" />
              </div>
              <h3 className="mb-2 font-semibold">{feature.title}</h3>
              <p className="text-sm text-muted-foreground">{feature.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  )
}
