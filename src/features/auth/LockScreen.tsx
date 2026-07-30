import { useState } from 'react'
import {
  MAX_PIN_LENGTH,
  MIN_PIN_LENGTH,
  RECOMMENDED_PIN_LENGTH,
  validatePin,
} from '@/auth/pin'
import { enrollDevice, linkDeviceWithPin, unlockWithPin } from '@/auth/session'
import type { SealedSession } from '@/auth/pin'

interface Props {
  sealed: SealedSession | null
  onUnlocked: () => void
  /**
   * Por qué se ha vuelto a esta pantalla, si es que se ha vuelto por algo.
   *
   * El caso real: alguien revoca este iPad desde otro dispositivo y la sesión
   * desaparece a media mañana. Sin la frase, lo que se ve es una aplicación que
   * de pronto pide el alta otra vez y parece rota.
   */
  aviso?: string | null
}

/**
 * Cómo se entra por primera vez en ESTE aparato. Dos caminos y ninguno de más:
 *
 *  - `codigo`: el alta de siempre. Es el único que funciona para quien todavía
 *    no usa la aplicación en ningún sitio, así que viene elegido de fábrica.
 *  - `pin`: ya la usa en otro dispositivo. Email y el PIN que ya tiene, sin
 *    llamar a nadie. Es el camino del segundo y el tercer aparato, que es donde
 *    estaba la fricción que esto viene a quitar.
 */
type Alta = 'codigo' | 'pin'

/**
 * Pantalla de entrada.
 *
 * Tres estados, no dos: teclear el PIN de un dispositivo que ya está dado de
 * alta —que funciona sin cobertura y es lo de todos los días—, darse de alta con
 * un código, o vincularse con el PIN que ya se usa en otro aparato.
 */
export function LockScreen({ sealed, onUnlocked, aviso }: Props): React.ReactElement {
  const [pin, setPin] = useState('')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [alta, setAlta] = useState<Alta>('codigo')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const enrolling = sealed === null
  const conCodigo = enrolling && alta === 'codigo'
  const conPin = enrolling && alta === 'pin'

  async function submit(): Promise<void> {
    setError(null)
    setBusy(true)

    try {
      if (conCodigo) {
        // El PIN se elige aquí, así que aquí se valida. En el camino del PIN no:
        // ahí se teclea uno que ya existe, y rechazarlo por «poco seguro» sería
        // negarle la entrada a alguien por una decisión que ya está tomada.
        const check = validatePin(pin)
        if (!check.ok) {
          setError(check.reason ?? 'PIN no válido.')
          return
        }
        const result = await enrollDevice(email.trim(), code.trim(), pin)
        if (!result.ok) {
          setError(result.error ?? 'No se pudo dar de alta el dispositivo.')
          return
        }
        onUnlocked()
        return
      }

      if (conPin) {
        const result = await linkDeviceWithPin(email.trim(), pin)
        if (!result.ok) {
          setError(result.error ?? 'No se ha podido vincular este dispositivo.')
          setPin('')
          return
        }
        onUnlocked()
        return
      }

      const result = await unlockWithPin(pin)
      if (!result.ok) {
        /*
         * «Te quedan undefined intentos.»
         *
         * El contador solo existe cuando el fallo ES del PIN. Cuando no lo es
         * —el servidor rechaza la sesión, por ejemplo— no hay intentos que
         * contar, y la frase se pegaba igual con un `undefined` dentro. Un
         * mensaje de error que enseña un `undefined` destruye la confianza en
         * todo lo demás que diga la pantalla.
         */
        setError(
          [
            result.error ?? 'No se ha podido desbloquear.',
            result.attemptsLeft !== undefined && `Te quedan ${result.attemptsLeft} intentos.`,
          ]
            .filter(Boolean)
            .join(' '),
        )
        setPin('')
        return
      }
      onUnlocked()
    } finally {
      setBusy(false)
    }
  }

  const titulo = !enrolling
    ? `Hola, ${sealed.hint.fullName}`
    : conPin
      ? 'Usar mi cuenta aquí'
      : 'Dar de alta este dispositivo'

  const subtitulo = !enrolling
    ? 'Introduce tu PIN.'
    : conPin
      ? 'Tu correo y el PIN que ya usas en el otro dispositivo. No hace falta código.'
      : 'Con el código que te ha dado un administrador. Solo hace falta una vez.'

  return (
    <div className="flex min-h-dvh flex-col justify-center px-6 py-12">
      <div className="mx-auto w-full max-w-sm">
        {aviso && (
          <p className="mb-6 rounded-ctl border border-warn/40 bg-warn-tint px-3 py-2 text-sm text-warn">
            {aviso}
          </p>
        )}
        <p className="eyebrow">Mantenimiento de aulas</p>
        <h1 className="mt-1 text-2xl font-semibold">{titulo}</h1>
        <p className="mt-2 text-sm text-muted">{subtitulo}</p>

        {/*
          El selector solo aparece cuando hay algo que elegir. En el desbloqueo
          de todos los días no hay dos formas de entrar, y enseñar un control que
          no hace nada es peor que no enseñarlo.
        */}
        {enrolling && (
          <div className="mt-6 flex gap-1 rounded-ctl border border-line bg-surface p-1">
            {(
              [
                { id: 'codigo', label: 'Con código' },
                { id: 'pin', label: 'Con mi PIN' },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  setAlta(m.id)
                  setError(null)
                }}
                aria-pressed={alta === m.id}
                className={`min-h-11 flex-1 rounded-ctl px-2 text-xs font-semibold ${
                  alta === m.id ? 'key key-accent' : 'text-muted'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}

        <form
          className="mt-6 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {enrolling && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Email</span>
              <input
                type="email"
                name="email"
                autoComplete="username"
                inputMode="email"
                autoCapitalize="off"
                autoCorrect="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-touch rounded-ctl border border-line bg-surface px-3"
                required
              />
            </label>
          )}

          {conCodigo && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Código de alta</span>
              <input
                type="text"
                name="enrollment-code"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="h-touch rounded-ctl border border-line bg-surface px-3 font-mono"
                required
              />
            </label>
          )}

          {/*
            Campo de usuario en la pantalla de desbloqueo.
            Un gestor de contraseñas necesita saber a QUÉ cuenta pertenece la
            credencial. Con solo el campo de PIN, Safari y Chrome no ofrecen
            guardarlo, o lo guardan sin poder recuperarlo después. Va visible y
            de solo lectura: además de hacer que el guardado funcione, confirma
            de un vistazo con qué cuenta vas a entrar.
          */}
          {!enrolling && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Cuenta</span>
              <input
                type="text"
                name="username"
                autoComplete="username"
                value={sealed.hint.email}
                readOnly
                tabIndex={-1}
                className="h-touch rounded-ctl border border-line bg-raised px-3 text-muted"
              />
            </label>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">
              {conCodigo
                ? `Elige un PIN de ${MIN_PIN_LENGTH} a ${MAX_PIN_LENGTH} dígitos`
                : conPin
                  ? 'Tu PIN'
                  : 'PIN'}
            </span>
            <input
              type="password"
              name="pin"
              inputMode="numeric"
              // `current-password` es lo que hace que el navegador ofrezca
              // recordarlo y lo rellene solo la próxima vez.
              autoComplete={conCodigo ? 'new-password' : 'current-password'}
              pattern="\d*"
              maxLength={MAX_PIN_LENGTH}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              className="h-touch rounded-ctl border border-line bg-surface px-3 text-center font-mono text-2xl tracking-[0.5em]"
              required
              autoFocus={!enrolling}
            />
          </label>

          {/*
            La recomendación va aquí y solo aquí: en el momento en que se elige.
            Con la bóveda, el PIN pasa a proteger algo que vive en el servidor, y
            dos dígitos más son cien veces más combinaciones por el mismo gesto.
            Es un consejo, no un bloqueo — cuatro se siguen aceptando.
          */}
          {conCodigo && pin.length > 0 && pin.length < RECOMMENDED_PIN_LENGTH && (
            <p className="-mt-2 text-xs text-muted">
              Con {RECOMMENDED_PIN_LENGTH} dígitos protege mucho más, y se teclea igual de rápido.
            </p>
          )}

          {error && (
            <p role="alert" className="text-sm text-crit">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || pin.length < MIN_PIN_LENGTH}
            className="key key-accent h-touch"
          >
            {busy
              ? 'Un momento…'
              : conCodigo
                ? 'Dar de alta'
                : conPin
                  ? 'Entrar en este dispositivo'
                  : 'Entrar'}
          </button>
        </form>

        {conPin && (
          <p className="mt-4 text-xs text-muted">
            Vincular necesita conexión una sola vez. A partir de ahí este dispositivo funciona sin
            cobertura como cualquier otro.
          </p>
        )}
        {conCodigo && (
          <p className="mt-4 text-xs text-muted">
            ¿Ya usas la aplicación en otro dispositivo?{' '}
            <button
              type="button"
              onClick={() => {
                setAlta('pin')
                setError(null)
              }}
              className="font-medium text-accent underline-offset-4 hover:underline"
            >
              Entra con tu PIN
            </button>
            .
          </p>
        )}
      </div>
    </div>
  )
}
