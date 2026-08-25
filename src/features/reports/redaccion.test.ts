import { describe, expect, it } from 'vitest'
import { redaccionDe } from './redaccion'

describe('el distintivo de un informe del archivo', () => {
  it('marca en verde el que redactó la IA', () => {
    const r = redaccionDe({ ia: true, ia_pedida: true })
    expect(r?.etiqueta).toBe('Redactado con IA')
    expect(r?.clase).toContain('ok')
    expect(r?.aviso).toBeNull()
  })

  it('no llama fallo al que se pidió sin IA a propósito', () => {
    const r = redaccionDe({ ia: false, ia_pedida: false })
    expect(r?.etiqueta).toBe('Análisis calculado')
    expect(r?.clase).not.toContain('warn')
    expect(r?.aviso).toBeNull()
  })

  it('distingue el que la pidió y no la tuvo, y dice por qué', () => {
    const r = redaccionDe({ ia: false, ia_pedida: true, aviso_ia: 'la clave no tiene permiso' })
    expect(r?.etiqueta).toBe('La IA falló')
    expect(r?.clase).toContain('warn')
    expect(r?.aviso).toBe('la clave no tiene permiso')
  })

  it('sigue avisando del fallo aunque no se guardara el motivo', () => {
    for (const params of [
      { ia: false, ia_pedida: true },
      { ia: false, ia_pedida: true, aviso_ia: '' },
      { ia: false, ia_pedida: true, aviso_ia: '   ' },
    ]) {
      const r = redaccionDe(params)
      expect(r?.etiqueta).toBe('La IA falló')
      expect(r?.aviso).toBe('no se guardó el motivo')
    }
  })

  /*
   * Los informes de la versión con worker no guardaron nada de esto. Lo que
   * corresponde es callarse, no rellenar el hueco: decir «análisis calculado»
   * de un informe que a lo mejor salió con IA es peor que no decir nada.
   */
  it('no dice nada de un informe que no lo guardó', () => {
    expect(redaccionDe(null)).toBeNull()
    expect(redaccionDe(undefined)).toBeNull()
    expect(redaccionDe({})).toBeNull()
    expect(redaccionDe({ ia_pedida: true })).toBeNull()
  })
})
