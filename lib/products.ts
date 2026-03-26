export interface Product {
  id: string
  name: string
  description: string
  priceInCents: number
  features: string[]
}

export const PRODUCTS: Product[] = [
  {
    id: "premium-monthly",
    name: "InstaDown Premium",
    description: "Descargas ilimitadas por un mes",
    priceInCents: 25, // $0.25
    features: [
      "Descargas ilimitadas",
      "Sin anuncios",
      "Descarga en alta calidad",
      "Soporte prioritario",
      "Acceso a todas las funciones",
    ],
  },
]

export const FREE_DAILY_LIMIT = 2
