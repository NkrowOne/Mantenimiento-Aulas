import { beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit, clearAllRateLimits, resetRateLimit } from "./rate-limit";

const options = { windowMs: 1000, maxAttempts: 3 };

beforeEach(() => {
  clearAllRateLimits();
});

describe("checkRateLimit", () => {
  it("permite hasta maxAttempts intentos dentro de la ventana", () => {
    const now = Date.now();
    expect(checkRateLimit("k", options, now).allowed).toBe(true);
    expect(checkRateLimit("k", options, now).allowed).toBe(true);
    expect(checkRateLimit("k", options, now).allowed).toBe(true);
  });

  it("bloquea a partir del intento maxAttempts + 1", () => {
    const now = Date.now();
    checkRateLimit("k", options, now);
    checkRateLimit("k", options, now);
    checkRateLimit("k", options, now);

    const result = checkRateLimit("k", options, now);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("se reinicia sola al pasar la ventana", () => {
    const now = Date.now();
    checkRateLimit("k", options, now);
    checkRateLimit("k", options, now);
    checkRateLimit("k", options, now);
    expect(checkRateLimit("k", options, now).allowed).toBe(false);

    const afterWindow = now + options.windowMs + 1;
    expect(checkRateLimit("k", options, afterWindow).allowed).toBe(true);
  });

  it("claves distintas no interfieren entre sí (una por email intentado)", () => {
    const now = Date.now();
    checkRateLimit("email-a@example.com", options, now);
    checkRateLimit("email-a@example.com", options, now);
    checkRateLimit("email-a@example.com", options, now);
    expect(checkRateLimit("email-a@example.com", options, now).allowed).toBe(
      false,
    );

    expect(checkRateLimit("email-b@example.com", options, now).allowed).toBe(
      true,
    );
  });

  it("resetRateLimit limpia el contador de una clave concreta", () => {
    const now = Date.now();
    checkRateLimit("k", options, now);
    checkRateLimit("k", options, now);
    checkRateLimit("k", options, now);
    expect(checkRateLimit("k", options, now).allowed).toBe(false);

    resetRateLimit("k");
    expect(checkRateLimit("k", options, now).allowed).toBe(true);
  });
});
