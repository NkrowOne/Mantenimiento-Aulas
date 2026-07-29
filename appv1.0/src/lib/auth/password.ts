import { hash, verify } from "@node-rs/argon2";

/**
 * Parámetros OWASP recomendados para Argon2id en autenticación
 * interactiva (m=19 MiB, t=2, p=1). El PIN usa un `timeCost` algo mayor:
 * un PIN de 4 dígitos tiene muy poca entropía (10 000 combinaciones), así
 * que encarecer su verificación offline es la única compensación posible
 * a nivel de hash — la defensa real contra fuerza bruta de un PIN es el
 * *rate limiting* (ver `src/lib/auth/rate-limit.ts`), no el coste del hash.
 */
const PASSWORD_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };
const PIN_OPTIONS = { memoryCost: 19_456, timeCost: 3, parallelism: 1 };

/**
 * Hash y verificación de contraseñas con Argon2id.
 * Independiente de {@link hashPin}/{@link verifyPin}: aunque ambas usan el
 * mismo algoritmo, nunca comparten hash, salt ni parámetros, y viven en
 * columnas distintas (`users.password_hash` / `users.pin_hash`).
 */
export function hashPassword(password: string): Promise<string> {
  return hash(password, PASSWORD_OPTIONS);
}

export function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  return verify(passwordHash, password, PASSWORD_OPTIONS);
}

/** Hash y verificación del PIN de reapertura, con Argon2id independiente. */
export function hashPin(pin: string): Promise<string> {
  return hash(pin, PIN_OPTIONS);
}

export function verifyPin(pinHash: string, pin: string): Promise<boolean> {
  return verify(pinHash, pin, PIN_OPTIONS);
}

/**
 * Hash fijo, calculado una vez al arrancar, de un valor que ningún
 * usuario real puede tener. `authorizePassword`/`authorizePin` lo
 * verifican cuando el email no existe, para que un email inexistente
 * tarde aproximadamente lo mismo que uno real con la contraseña/PIN
 * equivocados — sin este paso, la ausencia de un `hash()` real sería una
 * fuga de tiempo que revela si el email existe (ver docs/AUTENTICACION.md
 * § protección contra enumeración de usuarios).
 */
export const DUMMY_PASSWORD_HASH: Promise<string> = hashPassword(
  "dummy-password-para-igualar-tiempos-de-verificacion",
);
export const DUMMY_PIN_HASH: Promise<string> = hashPin("0000");
