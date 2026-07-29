import { describe, expect, it } from 'vitest'
import { enlaceDeSala, salaDeLaUrl } from './enlace-sala'

const UUID = '0198f2c1-3a4b-7c5d-8e6f-a47b91c2d3e4'

describe('enlaceDeSala', () => {
  it('produce una URL que la cámara reconoce como enlace', () => {
    expect(enlaceDeSala(UUID, 'https://aulas.example')).toBe(
      `https://aulas.example/?sala=${UUID}`,
    )
  })

  it('lo que se codifica es el identificador, no el nombre', () => {
    // Es lo que hace que renombrar una sala no invalide las placas atornilladas.
    expect(enlaceDeSala(UUID, 'https://aulas.example')).toContain(UUID)
  })
})

describe('salaDeLaUrl', () => {
  it('recupera la sala del enlace que imprime la placa', () => {
    const url = new URL(enlaceDeSala(UUID, 'https://aulas.example'))
    expect(salaDeLaUrl(url.search)).toBe(UUID)
  })

  it('acepta mayúsculas y las normaliza', () => {
    expect(salaDeLaUrl(`?sala=${UUID.toUpperCase()}`)).toBe(UUID)
  })

  it('no devuelve nada cuando no hay parámetro', () => {
    expect(salaDeLaUrl('')).toBeNull()
    expect(salaDeLaUrl('?otra=cosa')).toBeNull()
  })

  it('rechaza lo que no es un identificador', () => {
    // Lo que llega por la URL lo escribe cualquiera: acaba en una consulta, así
    // que o tiene la forma exacta o no se usa.
    expect(salaDeLaUrl('?sala=../../etc/passwd')).toBeNull()
    expect(salaDeLaUrl("?sala=1' or '1'='1")).toBeNull()
    expect(salaDeLaUrl('?sala=0198f2c1')).toBeNull()
  })
})
