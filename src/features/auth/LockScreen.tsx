import { useState } from 'react'
import { MAX_PIN_LENGTH, MIN_PIN_LENGTH, validatePin } from '@/auth/pin'
import { enrollDevice, unlockWithPin } from '@/auth/session'
import type { SealedSession } from '@/auth/pin'

interface Props {
  sealed: SealedSession | null
  onUnlocked: () => void
}

/**
 * Pantalla de entrada. Dos modos según si el dispositivo ya está dado de alta:
 * teclear el PIN (funciona sin cobertura) o darse de alta con email y código.
 */
export function LockScreen({ sealed, onUnlocked }: Props): React.ReactElement {
  const [pin, setPin] = useState('')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const enrolling = sealed === null

  async function submit(): Promise<void> {
    setError(null)
    setBusy(true)

    try {
      if (enrolling) {
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
      } else {
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
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col justify-center px-6 py-12">
      <div className="mx-auto w-full max-w-sm">
        <p className="eyebrow">Mantenimiento de aulas</p>
        <h1 className="mt-1 text-2xl font-semibold">
          {enrolling ? 'Dar de alta este dispositivo' : `Hola, ${sealed.hint.fullName}`}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {enrolling ? 'Solo hace falta una vez por dispositivo.' : 'Introduce tu PIN.'}
        </p>

        <form
          className="mt-8 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {enrolling && (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">Email</span>
                <input
                  type="email"
                  name="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-touch rounded-ctl border border-line bg-surface px-3"
                  required
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">Código de alta</span>
                <input
                  type="text"
                  name="enrollment-code"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="h-touch rounded-ctl border border-line bg-surface px-3 font-mono"
                  required
                />
              </label>
            </>
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
              {enrolling ? `Elige un PIN de ${MIN_PIN_LENGTH} a ${MAX_PIN_LENGTH} dígitos` : 'PIN'}
            </span>
            <input
              type="password"
              name="pin"
              inputMode="numeric"
              // `current-password` es lo que hace que el navegador ofrezca
              // recordarlo y lo rellene solo la próxima vez.
              autoComplete={enrolling ? 'new-password' : 'current-password'}
              pattern="\d*"
              maxLength={MAX_PIN_LENGTH}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              className="h-touch rounded-ctl border border-line bg-surface px-3 text-center font-mono text-2xl tracking-[0.5em]"
              required
              autoFocus={!enrolling}
            />
          </label>

          {error && <p className="text-sm text-crit">{error}</p>}

          <button
            type="submit"
            disabled={busy || pin.length < MIN_PIN_LENGTH}
            className="key key-accent h-touch"
          >
            {busy ? 'Un momento…' : enrolling ? 'Dar de alta' : 'Entrar'}
          </button>
        </form>

      </div>
    </div>
  )
}
