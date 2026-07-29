/**
 * Rate limiting básico, en memoria (contador de ventana fija por clave).
 *
 * Deliberadamente simple: un `Map` por proceso, sin persistencia ni
 * coordinación entre réplicas. Es suficiente para una sola instancia de
 * la app (el despliegue actual, ver docs/PLAN.md § Despliegue), pero si
 * en el futuro se ejecuta más de una réplica de `app` a la vez, cada una
 * llevaría su propio contador — para eso hace falta un almacén compartido
 * (Redis/Upstash), fuera del alcance de "básico".
 */

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  /** Duración de la ventana, en milisegundos. */
  windowMs: number;
  /** Intentos permitidos dentro de la ventana. */
  maxAttempts: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Milisegundos hasta que se pueda volver a intentar, si `allowed` es false. */
  retryAfterMs: number;
}

/** Login: 5 intentos por email cada 15 minutos. */
export const LOGIN_RATE_LIMIT: RateLimitOptions = {
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
};

/** PIN: mismo límite que el login — un PIN de 4 dígitos no admite más margen. */
export const PIN_RATE_LIMIT: RateLimitOptions = {
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
};

/**
 * Registra un intento para `key` y dice si está permitido. Cada llamada
 * cuenta como un intento (llámalo una sola vez por intento de login/PIN).
 */
export function checkRateLimit(
  key: string,
  options: RateLimitOptions,
  now: number = Date.now(),
): RateLimitResult {
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= options.windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (bucket.count >= options.maxAttempts) {
    return {
      allowed: false,
      retryAfterMs: options.windowMs - (now - bucket.windowStart),
    };
  }

  bucket.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

/** Se llama tras un login/PIN correcto, para no penalizar al usuario legítimo. */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/** Solo para tests: vacía todos los contadores entre casos. */
export function clearAllRateLimits(): void {
  buckets.clear();
}
