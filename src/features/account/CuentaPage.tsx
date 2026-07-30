import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useConfirmar } from '@/components/Confirmar'
import {
  MAX_PIN_LENGTH,
  MIN_PIN_LENGTH,
  RECOMMENDED_PIN_LENGTH,
  validatePin,
} from '@/auth/pin'
import {
  changePin,
  estadoBoveda,
  misDispositivos,
  revocarDispositivo,
  type Dispositivo,
} from '@/auth/session'
import { desdeHace, fechaCorta } from '@/domain/fechas'
import type { Role } from '@/domain/types'

/**
 * Mi cuenta: en qué aparatos estoy y con qué PIN entro.
 *
 * Existe porque la aplicación pasa a poder usarse en tres dispositivos, y en
 * cuanto hay tres hace falta poder verlos. Un tope que no se puede inspeccionar
 * es un tope que un día dice «ya tienes tres» y no hay forma de saber cuáles.
 *
 * Se llega desde la chapa del rol de la cabecera, no desde una pestaña: esto se
 * abre dos veces al año y una pestaña permanente le robaría sitio a las cinco
 * que se usan todos los días.
 */

interface Props {
  userId: string | null
  role: Role
  email: string
  fullName: string
  onCerrar: () => void
  onCerrarSesion: () => void
}

export function CuentaPage({
  userId,
  role,
  email,
  fullName,
  onCerrar,
  onCerrarSesion,
}: Props): React.ReactElement {
  const qc = useQueryClient()
  const { pedir, dialogo } = useConfirmar()
  const [nota, setNota] = useState<string | null>(null)

  const dispositivos = useQuery({
    queryKey: ['dispositivos', userId],
    queryFn: () => misDispositivos(userId),
    enabled: Boolean(userId),
  })

  const boveda = useQuery({ queryKey: ['boveda'], queryFn: estadoBoveda })

  const revocar = useMutation({
    mutationFn: (d: Dispositivo) => revocarDispositivo(d.id),
    onSuccess: () => {
      setNota('Dispositivo revocado.')
      void qc.invalidateQueries({ queryKey: ['dispositivos'] })
      void qc.invalidateQueries({ queryKey: ['boveda'] })
    },
  })

  const activos = (dispositivos.data ?? []).filter((d) => !d.revoked_at)
  const retirados = (dispositivos.data ?? []).filter((d) => d.revoked_at)

  return (
    <div className="mx-auto max-w-2xl p-4 pb-24">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Mi cuenta</p>
          <h1 className="mt-1 truncate text-xl font-semibold">{fullName}</h1>
          <p className="truncate text-sm text-muted">
            {email} · {role}
          </p>
        </div>
        <button type="button" onClick={onCerrar} className="key key-quiet min-h-11 shrink-0 px-3 text-sm">
          Volver
        </button>
      </div>

      {/* ---------------------------------------------------------------- */}
      <section aria-labelledby="sec-dispositivos" className="mt-8">
        <div className="section-head">
          <h2 id="sec-dispositivos" className="eyebrow">
            Mis dispositivos
          </h2>
        </div>

        <p className="text-sm text-muted">
          {boveda.data
            ? `${activos.length} de ${boveda.data.maximo} en uso.`
            : `${activos.length} en uso.`}{' '}
          Para entrar en uno nuevo basta tu correo y tu PIN — sin código. Si te falta hueco, revoca
          aquí el que ya no uses.
        </p>

        {/*
          «Sin sesión» no es «cargando», y confundirlos dejaba esta pantalla
          colgada para siempre.

          La consulta va con `enabled: Boolean(userId)`, y una consulta
          deshabilitada de react-query se queda en `isPending` eternamente: nunca
          corre, así que nunca falla ni termina. Quien desbloquea con el PIN en un
          sótano —el caso que este proyecto defiende expresamente— abría «Mi
          cuenta» y leía «Cargando…» hasta que se cansaba, sin un error, sin una
          explicación, y siendo este el único sitio desde el que se revoca un
          aparato para hacer hueco al cuarto.

          Ahora se dice lo que pasa y qué hacer. Lo demás de la pantalla —el PIN,
          cerrar sesión— sigue funcionando, así que no se tapa entera.
        */}
        {!userId && (
          <p className="mt-3 rounded-ctl border border-line bg-sunken px-3 py-2 text-sm text-muted">
            Ver tus dispositivos necesita conexión: la lista la tiene el servidor, no este aparato.
            Vuelve a entrar donde haya línea y aparecerá aquí.
          </p>
        )}
        {userId && dispositivos.isPending && <p className="mt-3 text-sm text-muted">Cargando…</p>}
        {dispositivos.isError && (
          <p className="mt-3 text-sm text-crit">
            No se han podido leer:{' '}
            {dispositivos.error instanceof Error ? dispositivos.error.message : ''}
          </p>
        )}

        <ul className="mt-3 space-y-2">
          {activos.map((d) => (
            <li key={d.id} className="card flex flex-wrap items-center gap-3 p-3">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{d.label}</span>
                  {d.esEste && (
                    <span className="shrink-0 rounded-tag bg-accent-tint px-1.5 py-0.5 text-[0.6875rem] font-semibold text-accent">
                      este
                    </span>
                  )}
                </span>
                <span className="block truncate text-xs text-muted">
                  {[
                    d.enrolled_via === 'pin' ? 'vinculado con el PIN' : 'alta con código',
                    `desde el ${fechaCorta(d.enrolled_at)}`,
                    d.last_seen_at ? `visto ${desdeHace(d.last_seen_at)}` : 'nunca conectado',
                  ].join(' · ')}
                </span>
              </span>

              <button
                type="button"
                disabled={revocar.isPending}
                onClick={() =>
                  void pedir({
                    titulo: d.esEste ? '¿Revocar este dispositivo?' : `¿Revocar «${d.label}»?`,
                    detalle: d.esEste
                      ? 'Estás revocando el aparato desde el que lo estás haciendo.'
                      : 'Ese aparato dejará de estar dado de alta.',
                    consecuencias: [
                      'La próxima vez que abra la aplicación borrará la sesión guardada y pedirá el alta otra vez.',
                      'Libera un hueco: podrás dar de alta otro dispositivo.',
                      'Lo que ese dispositivo tuviera sin sincronizar se perderá.',
                    ],
                    confirmar: 'Revocar',
                    tono: 'crit',
                  }).then((si) => si && revocar.mutate(d))
                }
                className="key key-quiet min-h-11 shrink-0 px-3 text-xs text-muted"
              >
                Revocar
              </button>
            </li>
          ))}

          {dispositivos.data && activos.length === 0 && (
            <li className="text-sm text-muted">No hay ningún dispositivo activo.</li>
          )}
        </ul>

        {retirados.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted">
              {retirados.length} retirado(s)
            </summary>
            <ul className="mt-2 space-y-1">
              {retirados.map((d) => (
                <li key={d.id} className="text-xs text-muted">
                  {d.label} · retirado el {fechaCorta(d.revoked_at ?? '')}
                  {d.revocado_por ? ` por ${d.revocado_por}` : ''}
                  {d.revoked_reason ? ` — ${d.revoked_reason}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}

        {revocar.isError && (
          <p className="mt-3 text-sm text-crit">
            {revocar.error instanceof Error ? revocar.error.message : 'No se ha podido revocar.'}
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <CambiarPin
        activa={Boolean(boveda.data?.existe)}
        caducada={Boolean(boveda.data?.caducada)}
        onHecho={(mensaje) => {
          setNota(mensaje)
          void qc.invalidateQueries({ queryKey: ['boveda'] })
        }}
      />

      {nota && (
        <p aria-live="polite" className="mt-6 text-sm text-ok">
          {nota}
        </p>
      )}

      <section className="mt-10 border-t border-line pt-6">
        <button
          type="button"
          onClick={() =>
            void pedir({
              titulo: '¿Cerrar sesión?',
              detalle: 'La sesión no caduca sola: solo termina aquí.',
              consecuencias: [
                'Volver a entrar solo pide tu PIN: el dispositivo sigue dado de alta.',
                'Lo que esté sin sincronizar se queda esperando y sube al volver a entrar.',
              ],
              confirmar: 'Cerrar sesión',
              tono: 'warn',
            }).then((si) => si && onCerrarSesion())
          }
          className="key key-quiet min-h-touch w-full px-4 text-sm"
        >
          Cerrar sesión
        </button>
      </section>

      {dialogo}
    </div>
  )
}

/**
 * Cambiar el PIN.
 *
 * Pide el actual y no lo comprueba en local: lo canjea contra la bóveda del
 * servidor. Así el cambio prueba que quien lo pide sabe el PIN de la CUENTA —no
 * solo el de este aparato— y de paso recupera lo que hay que volver a envolver.
 */
function CambiarPin({
  activa,
  caducada,
  onHecho,
}: {
  activa: boolean
  caducada: boolean
  onHecho: (mensaje: string) => void
}): React.ReactElement {
  const [abierto, setAbierto] = useState(false)
  const [actual, setActual] = useState('')
  const [nuevo, setNuevo] = useState('')
  const [repetido, setRepetido] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function guardar(): Promise<void> {
    setError(null)
    if (nuevo !== repetido) {
      setError('Los dos PIN nuevos no coinciden.')
      return
    }
    const check = validatePin(nuevo)
    if (!check.ok) {
      setError(check.reason ?? 'PIN no válido.')
      return
    }

    setBusy(true)
    try {
      const r = await changePin(actual, nuevo)
      if (!r.ok) {
        setError(r.error ?? 'No se ha podido cambiar.')
        return
      }
      setAbierto(false)
      setActual('')
      setNuevo('')
      setRepetido('')
      onHecho('PIN cambiado. Este dispositivo ya usa el nuevo.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="sec-pin" className="mt-8">
      <div className="section-head">
        <h2 id="sec-pin" className="eyebrow">
          Mi PIN
        </h2>
      </div>

      {!activa ? (
        <p className="text-sm text-muted">
          {caducada
            ? 'Se ha emitido un código de alta nuevo para tu cuenta, así que la vinculación por PIN está en pausa hasta que alguien lo use.'
            : 'Todavía no se ha preparado la vinculación de esta cuenta. Se prepara sola la próxima vez que entres con conexión.'}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted">
            El mismo PIN desbloquea este aparato y da de alta los siguientes.{' '}
            {MIN_PIN_LENGTH} dígitos como mínimo; con {RECOMMENDED_PIN_LENGTH} protege mucho más.
          </p>

          {!abierto ? (
            <button
              type="button"
              onClick={() => setAbierto(true)}
              className="key key-quiet mt-3 min-h-11 px-3 text-sm"
            >
              Cambiar el PIN
            </button>
          ) : (
            <form
              className="card mt-3 grid gap-3 p-4"
              onSubmit={(e) => {
                e.preventDefault()
                void guardar()
              }}
            >
              {(
                [
                  ['PIN actual', actual, setActual, 'current-password'],
                  ['PIN nuevo', nuevo, setNuevo, 'new-password'],
                  ['Repite el PIN nuevo', repetido, setRepetido, 'new-password'],
                ] as const
              ).map(([etiqueta, valor, set, auto]) => (
                <label key={etiqueta} className="text-xs text-muted">
                  {etiqueta}
                  <input
                    type="password"
                    inputMode="numeric"
                    autoComplete={auto}
                    pattern="\d*"
                    maxLength={MAX_PIN_LENGTH}
                    value={valor}
                    onChange={(e) => set(e.target.value.replace(/\D/g, ''))}
                    className="mt-1 h-11 w-full rounded-ctl border border-line bg-surface px-2 text-center font-mono text-lg tracking-[0.4em] text-ink"
                    required
                  />
                </label>
              ))}

              {error && (
                <p role="alert" className="text-sm text-crit">
                  {error}
                </p>
              )}

              {/*
                Lo único que sorprende de cambiar el PIN, dicho antes y no
                después: los otros dispositivos que YA están dentro siguen
                abriéndose con el viejo, porque su sobre local se cifró con él.
                Callarlo produce la llamada de «he cambiado el PIN y el iPad
                sigue con el de antes».
              */}
              <p className="text-xs text-muted">
                Los dispositivos que ya están dados de alta siguen desbloqueándose con su PIN
                anterior hasta que los vuelvas a vincular. El nuevo es el que vale para dar de alta
                dispositivos.
              </p>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAbierto(false)
                    setError(null)
                  }}
                  className="key key-quiet min-h-11 flex-1 px-3 text-sm"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={busy || nuevo.length < MIN_PIN_LENGTH || actual.length < MIN_PIN_LENGTH}
                  className="key key-accent min-h-11 flex-1 px-3 text-sm"
                >
                  {busy ? 'Guardando…' : 'Cambiar'}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  )
}
