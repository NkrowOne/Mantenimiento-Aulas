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
          setError(
            result.wiped
              ? result.error ?? 'Sesión borrada.'
              : `${result.error} Te quedan ${result.attemptsLeft} intentos.`,
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
          {enrolling
            ? 'Introduce tu email y el código que te ha dado administración. Solo hace falta una vez por dispositivo.'
            : 'Introduce tu PIN. Funciona aunque no haya cobertura.'}
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
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-touch rounded-lg border border-line bg-surface px-3"
                  required
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">Código de alta</span>
                <input
                  type="text"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="h-touch rounded-lg border border-line bg-surface px-3 font-mono"
                  required
                />
              </label>
            </>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">
              {enrolling ? `Elige un PIN de ${MIN_PIN_LENGTH} a ${MAX_PIN_LENGTH} dígitos` : 'PIN'}
            </span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete={enrolling ? 'new-password' : 'current-password'}
              pattern="\d*"
              maxLength={MAX_PIN_LENGTH}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              className="h-touch rounded-lg border border-line bg-surface px-3 text-center font-mono text-2xl tracking-[0.5em]"
              required
              autoFocus={!enrolling}
            />
          </label>

          {error && <p className="text-sm text-crit">{error}</p>}

          <button
            type="submit"
            disabled={busy || pin.length < MIN_PIN_LENGTH}
            className="h-touch rounded-lg bg-accent font-semibold text-accent-ink disabled:opacity-40"
          >
            {busy ? 'Un momento…' : enrolling ? 'Dar de alta' : 'Entrar'}
          </button>
        </form>

        {!enrolling && (
          <p className="mt-6 text-xs text-muted">
            El PIN no se envía a ningún sitio: descifra la sesión guardada en este dispositivo.
            Si lo fallas 5 veces habrá que pedir un código nuevo, pero tu trabajo ya registrado
            está a salvo en el servidor.
          </p>
        )}
      </div>
    </div>
  )
}
