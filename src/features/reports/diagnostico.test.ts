import { describe, expect, it } from 'vitest'
import { diagnostico, type EstadoInformes } from './diagnostico'

const AHORA = 1_800_000_000_000

function estado(over: Partial<EstadoInformes> = {}): EstadoInformes {
  return {
    pg_net: { instalado: true, en_cola: 0, ultima_respuesta: new Date(AHORA - 30_000).toISOString() },
    respuestas: [],
    peticiones: [],
    cron: [{ nombre: 'informe-semanal', horario: '0 5,6,7 * * 5', activo: true }],
    corridas: [],
    informes: [],
    ...over,
  }
}

describe('diagnostico', () => {
  it('la cola con contenido y pg_net mudo es LA avería: precarga que falta', () => {
    // El fallo real que dejó los informes sin generarse durante semanas, sin un
    // solo error visible: peticiones encoladas y ningún proceso despachándolas.
    const avisos = diagnostico(
      estado({ pg_net: { instalado: true, en_cola: 7, ultima_respuesta: null } }),
      AHORA,
    )
    expect(avisos[0]?.nivel).toBe('crit')
    expect(avisos[0]?.texto).toMatch(/shared_preload_libraries/)
  })

  it('cola parada pero con informes recién emitidos: aviso, no orden de reiniciar', () => {
    // El falso positivo del TTL: las respuestas caducan y una petición recién
    // encolada tarda unos segundos. Si hay informes de hace un rato, la
    // tubería demostró funcionar — un CRIT que ordena reiniciar sería mentira.
    const avisos = diagnostico(
      estado({
        pg_net: { instalado: true, en_cola: 1, ultima_respuesta: null },
        informes: [{ kind: 'semanal', generated_at: new Date(AHORA - 30 * 60_000).toISOString() }],
      }),
      AHORA,
    )
    expect(avisos[0]?.nivel).toBe('warn')
    expect(avisos.every((a) => a.nivel !== 'crit')).toBe(true)
  })

  it('la petición despachada sin respuesta apunta al worker, no a pg_net', () => {
    // La cola vacía dice que pg_net trabajó; el envío sin código ni error dice
    // que el worker no llegó a contestar — o que la respuesta ya caducó.
    const avisos = diagnostico(
      estado({
        peticiones: [
          {
            id: 7,
            kind: 'semanal',
            cuando: new Date(AHORA - 10 * 60_000).toISOString(),
            codigo: null,
            caduco: false,
            error: '',
            respondida: false,
          },
        ],
      }),
      AHORA,
    )
    expect(avisos.some((a) => a.nivel === 'warn' && /aulas-reports/.test(a.texto))).toBe(true)
  })

  it('cola con contenido pero respuestas recientes NO es la avería: está trabajando', () => {
    const avisos = diagnostico(
      estado({
        pg_net: { instalado: true, en_cola: 2, ultima_respuesta: new Date(AHORA - 10_000).toISOString() },
      }),
      AHORA,
    )
    expect(avisos.every((a) => a.nivel !== 'crit')).toBe(true)
  })

  it('sin pg_net instalado lo dice y no sigue adivinando', () => {
    const avisos = diagnostico(estado({ pg_net: { instalado: false } }), AHORA)
    expect(avisos).toHaveLength(1)
    expect(avisos[0]?.texto).toMatch(/pg_net no está instalada/)
  })

  it('un 401 del worker apunta al token, que es lo único que produce un 401', () => {
    const avisos = diagnostico(
      estado({ respuestas: [{ codigo: 401, caduco: false, error: '', cuando: '' }] }),
      AHORA,
    )
    expect(avisos.some((a) => a.nivel === 'crit' && /token/.test(a.texto))).toBe(true)
  })

  it('un fallo de conexión apunta al contenedor, no a la base', () => {
    const avisos = diagnostico(
      estado({
        respuestas: [{ codigo: null, caduco: false, error: 'Couldn\'t connect to server', cuando: '' }],
      }),
      AHORA,
    )
    expect(avisos.some((a) => a.nivel === 'crit' && /worker/.test(a.texto))).toBe(true)
  })

  it('un nombre que no resuelve enseña LA URL y manda a corregirla, no a reiniciar', () => {
    // El caso visto en producción: «Couldn't resolve host name» con la URL del
    // compose en un despliegue donde el worker se llama de otra manera. Con la
    // URL delante, el error es el diagnóstico entero.
    const avisos = diagnostico(
      estado({
        worker_url: 'http://reports-worker:8080/generate',
        respuestas: [
          { codigo: null, caduco: false, error: "Couldn't resolve host name", cuando: '' },
        ],
      }),
      AHORA,
    )
    const aviso = avisos.find((a) => a.nivel === 'crit')
    expect(aviso?.texto).toMatch(/http:\/\/reports-worker:8080\/generate/)
    expect(aviso?.texto).toMatch(/reports_worker_url/)
  })

  it('un timeout avisa de mirar el archivo antes de tocar nada', () => {
    // La entrega no se pierde por agotar la espera: el worker termina igual.
    const avisos = diagnostico(
      estado({ respuestas: [{ codigo: null, caduco: true, error: '', cuando: '' }] }),
      AHORA,
    )
    expect(avisos.some((a) => a.nivel === 'warn' && /archivo/.test(a.texto))).toBe(true)
  })

  it('el token de ejemplo se delata sin esperar a ningún 401', () => {
    // Un despliegue que no corrió deploy.sh conserva «cambiame-en-produccion»
    // y todo informe muere en un 401 que nadie ve. No hace falta esperar a la
    // primera llamada fallida para decirlo.
    const avisos = diagnostico(estado({ token_de_ejemplo: true }), AHORA)
    expect(avisos.some((a) => a.nivel === 'crit' && /token de ejemplo/.test(a.texto))).toBe(true)
  })

  it('con todo sano lo dice en verde, que también es un diagnóstico', () => {
    const avisos = diagnostico(estado(), AHORA)
    expect(avisos).toHaveLength(1)
    expect(avisos[0]?.nivel).toBe('ok')
  })

  it('sin ningún cron de informes avisa de que el viernes no saldrá solo', () => {
    const avisos = diagnostico(estado({ cron: [] }), AHORA)
    expect(avisos.some((a) => a.nivel === 'warn' && /viernes/.test(a.texto))).toBe(true)
  })
})
