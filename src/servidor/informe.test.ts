/**
 * Cada informe lee con la sesión de quien lo pidió, y solo con esa.
 *
 * Es lo único de este fichero que no se puede romper. El código del informe usa
 * un cliente de Supabase que es uno para toda la aplicación; en el servidor hay
 * uno por informe, y dos informes de dos personas pueden estar haciéndose a la
 * vez. Si el reparto se equivocara, uno leería con los permisos del otro —y un
 * informe con los datos que no le tocan no da ningún error: sale, se archiva y
 * se manda—.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Eleccion } from '@/features/reports/peticion'

/*
 * El informe de mentira: hace lo que hace el de verdad —leer con el cliente
 * compartido, antes y después de esperar— y devuelve con cuál leyó.
 */
vi.mock('@/features/reports/informe/generar', () => ({
  generarInforme: vi.fn(async (eleccion: Eleccion, _avisar: unknown, en: unknown) => {
    const { supabase } = await import('@/lib/supabase')
    const antes = (supabase as unknown as { from: (t: string) => string }).from('rooms')
    // Una espera de verdad, para que los dos informes se crucen.
    await new Promise((r) => setTimeout(r, eleccion.nota === 'lento' ? 40 : 5))
    const { data } = await supabase.auth.getSession()
    const despues = (supabase as unknown as { from: (t: string) => string }).from('rooms')
    return {
      html: JSON.stringify({ antes, despues, quien: data.session?.user.id, token: data.session?.access_token, en }),
    }
  }),
}))

const { generarEnElServidor } = await import('./informe')
const { supabase } = await import('@/lib/supabase')

/** Un cliente que dice quién es en cada lectura, y que comprueba que le llaman con su `this`. */
function clienteDe(nombre: string): SupabaseClient {
  const c = {
    nombre,
    from(tabla: string): string {
      return `${this.nombre}:${tabla}`
    },
  }
  return c as unknown as SupabaseClient
}

const eleccion = (nota = ''): Eleccion => ({
  kind: 'semanal',
  rango: { start: '2026-11-16', end: '2026-11-20' },
  secciones: ['resumen'],
  comparar: true,
  ia: false,
  audiencia: 'direccion',
  enfoque: '',
  nota,
})

const leer = async (p: Promise<{ html: string }>): Promise<Record<string, unknown>> =>
  JSON.parse((await p).html) as Record<string, unknown>

describe('el informe en el servidor', () => {
  it('lee con el cliente de quien lo pide, antes y después de cada espera', async () => {
    const r = await leer(generarEnElServidor(clienteDe('marta'), { id: 'u-marta', token: 't-marta' }, eleccion()))
    expect(r['antes']).toBe('marta:rooms')
    expect(r['despues']).toBe('marta:rooms')
  })

  it('dos informes a la vez no se cruzan: cada uno con su sesión', async () => {
    // El de Marta es lento y el de Luis empieza y acaba por en medio.
    const [marta, luis] = await Promise.all([
      leer(generarEnElServidor(clienteDe('marta'), { id: 'u-marta', token: 't-marta' }, eleccion('lento'))),
      leer(generarEnElServidor(clienteDe('luis'), { id: 'u-luis', token: 't-luis' }, eleccion())),
    ])
    expect(marta).toMatchObject({ antes: 'marta:rooms', despues: 'marta:rooms', quien: 'u-marta', token: 't-marta' })
    expect(luis).toMatchObject({ antes: 'luis:rooms', despues: 'luis:rooms', quien: 'u-luis', token: 't-luis' })
  })

  it('el informe sabe a nombre de quién va: firma la portada y la fila del archivo', async () => {
    // El cliente del servidor no tiene sesión propia; sin esto saldría sin autor.
    const r = await leer(generarEnElServidor(clienteDe('marta'), { id: 'u-marta', token: 't-marta' }, eleccion()))
    expect(r['quien']).toBe('u-marta')
  })

  it('va sin Excel, y con lo que el servidor trae para las fotos y la clave', async () => {
    const reducirFoto = (b: Blob): Promise<Blob> => Promise.resolve(b)
    const r = await leer(
      generarEnElServidor(clienteDe('marta'), { id: 'u', token: 't' }, eleccion(), undefined, {
        reducirFoto,
        claveDelDispositivo: 'clave-local',
      }),
    )
    expect(r['en']).toMatchObject({ sinExcel: true, claveDelDispositivo: 'clave-local' })
  })

  it('no se puede pedir que lleve Excel: allí no hay a quién dárselo', async () => {
    const colado = { sinExcel: false } as unknown as Parameters<typeof generarEnElServidor>[4]
    const r = await leer(generarEnElServidor(clienteDe('marta'), { id: 'u', token: 't' }, eleccion(), undefined, colado))
    expect(r['en']).toMatchObject({ sinExcel: true })
  })

  it('fuera de un informe no hay cliente: no se lee con la sesión de nadie', () => {
    expect(() => supabase.from('rooms')).toThrow(/fuera de su trabajo/)
  })

  it('y al terminar uno, su sesión no se queda puesta para el siguiente que pase', async () => {
    await generarEnElServidor(clienteDe('marta'), { id: 'u-marta', token: 't-marta' }, eleccion())
    expect(() => supabase.from('rooms')).toThrow(/fuera de su trabajo/)
  })
})
