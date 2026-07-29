import { describe, expect, it } from "vitest";
import {
  DUMMY_PASSWORD_HASH,
  DUMMY_PIN_HASH,
  hashPassword,
  hashPin,
  verifyPassword,
  verifyPin,
} from "./password";

describe("hashPassword / verifyPassword", () => {
  it("verifica correctamente la contraseña correcta", async () => {
    const hash = await hashPassword("Sup3rSecreta!");
    expect(await verifyPassword(hash, "Sup3rSecreta!")).toBe(true);
  });

  it("rechaza una contraseña incorrecta", async () => {
    const hash = await hashPassword("Sup3rSecreta!");
    expect(await verifyPassword(hash, "otra-cosa")).toBe(false);
  });

  it("usa Argon2id, no otra variante ni otro algoritmo", async () => {
    const hash = await hashPassword("Sup3rSecreta!");
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("nunca produce el mismo hash dos veces (salt aleatoria)", async () => {
    const [a, b] = await Promise.all([
      hashPassword("misma-contraseña"),
      hashPassword("misma-contraseña"),
    ]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "misma-contraseña")).toBe(true);
    expect(await verifyPassword(b, "misma-contraseña")).toBe(true);
  });
});

describe("hashPin / verifyPin", () => {
  it("verifica correctamente el PIN correcto", async () => {
    const hash = await hashPin("1234");
    expect(await verifyPin(hash, "1234")).toBe(true);
  });

  it("rechaza un PIN incorrecto", async () => {
    const hash = await hashPin("1234");
    expect(await verifyPin(hash, "0000")).toBe(false);
  });

  it("usa Argon2id, igual que la contraseña pero de forma independiente", async () => {
    const hash = await hashPin("1234");
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("el hash del PIN nunca coincide con el de una contraseña, aunque el valor sea igual", async () => {
    const passwordHash = await hashPassword("1234");
    const pinHash = await hashPin("1234");
    expect(passwordHash).not.toBe(pinHash);
  });
});

describe("hashes señuelo (protección contra enumeración)", () => {
  it("DUMMY_PASSWORD_HASH es un hash Argon2id válido que no verifica con cualquier intento", async () => {
    const hash = await DUMMY_PASSWORD_HASH;
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "cualquier-cosa")).toBe(false);
  });

  it("DUMMY_PIN_HASH es un hash Argon2id válido que no verifica con cualquier PIN", async () => {
    const hash = await DUMMY_PIN_HASH;
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPin(hash, "9999")).toBe(false);
  });
});
