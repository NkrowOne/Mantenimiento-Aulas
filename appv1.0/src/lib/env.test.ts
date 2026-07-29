import { describe, expect, it } from "vitest";
import {
  clientEnvSchema,
  parseClientEnv,
  parseServerEnv,
  serverEnvSchema,
} from "@/lib/env";

const validServerEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:pass@postgres:5432/db",
  APP_DATABASE_URL: "postgresql://app_runtime:pass@postgres:5432/db",
  STORAGE_DRIVER: "s3",
  S3_ENDPOINT: "http://minio:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "mantenimiento-aulas",
  S3_ACCESS_KEY: "minioadmin",
  S3_SECRET_KEY: "minioadmin-secret",
  AUTH_SECRET: "a-very-secret-value-that-is-at-least-32-chars",
};

const validClientEnv = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
};

describe("parseServerEnv", () => {
  it("acepta una configuración de servidor válida", () => {
    const env = parseServerEnv(validServerEnv);
    expect(env.DATABASE_URL).toBe(validServerEnv.DATABASE_URL);
    expect(env.STORAGE_DRIVER).toBe("s3");
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it("funciona sin GEMINI_API_KEY: la app debe poder arrancar sin Gemini", () => {
    expect(() => parseServerEnv(validServerEnv)).not.toThrow();
  });

  it("acepta GEMINI_API_KEY cuando se proporciona", () => {
    const env = parseServerEnv({
      ...validServerEnv,
      GEMINI_API_KEY: "gemini-key-123",
    });
    expect(env.GEMINI_API_KEY).toBe("gemini-key-123");
  });

  it("trata GEMINI_API_KEY='' como ausente (Docker Compose asigna cadena vacía, no undefined)", () => {
    const env = parseServerEnv({ ...validServerEnv, GEMINI_API_KEY: "" });
    expect(env.GEMINI_API_KEY).toBeUndefined();
  });

  it("aplica el valor por defecto de STORAGE_DRIVER cuando se omite", () => {
    const input: Record<string, string | undefined> = { ...validServerEnv };
    delete input.STORAGE_DRIVER;
    const env = parseServerEnv(input);
    expect(env.STORAGE_DRIVER).toBe("s3");
  });

  it("falla con un mensaje claro cuando falta una variable obligatoria", () => {
    const input: Record<string, string | undefined> = { ...validServerEnv };
    delete input.DATABASE_URL;
    expect(() => parseServerEnv(input)).toThrowError(/DATABASE_URL/);
  });

  it("falla cuando faltan varias variables obligatorias a la vez", () => {
    expect(() => parseServerEnv({})).toThrowError(
      /DATABASE_URL[\s\S]*S3_ENDPOINT[\s\S]*AUTH_SECRET|AUTH_SECRET[\s\S]*DATABASE_URL/,
    );
  });

  it("falla cuando DATABASE_URL no es una URL válida", () => {
    expect(() =>
      parseServerEnv({ ...validServerEnv, DATABASE_URL: "no-es-una-url" }),
    ).toThrowError(/DATABASE_URL/);
  });

  it("falla cuando falta APP_DATABASE_URL (el rol de mínimo privilegio de la app)", () => {
    const input: Record<string, string | undefined> = { ...validServerEnv };
    delete input.APP_DATABASE_URL;
    expect(() => parseServerEnv(input)).toThrowError(/APP_DATABASE_URL/);
  });

  it("falla cuando STORAGE_DRIVER tiene un valor no soportado", () => {
    expect(() =>
      parseServerEnv({ ...validServerEnv, STORAGE_DRIVER: "ftp" }),
    ).toThrowError(/STORAGE_DRIVER/);
  });

  it("falla cuando alguna variable obligatoria está vacía", () => {
    expect(() =>
      parseServerEnv({ ...validServerEnv, AUTH_SECRET: "" }),
    ).toThrowError(/AUTH_SECRET/);
  });

  it("falla cuando AUTH_SECRET es demasiado corto para firmar sesiones de forma segura", () => {
    expect(() =>
      parseServerEnv({ ...validServerEnv, AUTH_SECRET: "corto" }),
    ).toThrowError(/AUTH_SECRET/);
  });
});

describe("parseClientEnv", () => {
  it("acepta una configuración pública válida", () => {
    const env = parseClientEnv(validClientEnv);
    expect(env.NEXT_PUBLIC_APP_URL).toBe(validClientEnv.NEXT_PUBLIC_APP_URL);
  });

  it("falla con un mensaje claro cuando falta NEXT_PUBLIC_APP_URL", () => {
    expect(() => parseClientEnv({})).toThrowError(/NEXT_PUBLIC_APP_URL/);
  });

  it("falla cuando NEXT_PUBLIC_APP_URL no es una URL válida", () => {
    expect(() =>
      parseClientEnv({ NEXT_PUBLIC_APP_URL: "no-es-una-url" }),
    ).toThrowError(/NEXT_PUBLIC_APP_URL/);
  });
});

describe("separación entre variables de servidor y públicas", () => {
  it("ninguna variable del esquema de servidor lleva el prefijo NEXT_PUBLIC_", () => {
    const serverKeys = Object.keys(serverEnvSchema.shape);
    for (const key of serverKeys) {
      expect(key.startsWith("NEXT_PUBLIC_")).toBe(false);
    }
  });

  it("el esquema público no incluye ninguna variable secreta de servidor", () => {
    const serverKeys = new Set(Object.keys(serverEnvSchema.shape));
    const clientKeys = Object.keys(clientEnvSchema.shape);
    for (const key of clientKeys) {
      expect(serverKeys.has(key)).toBe(false);
    }
  });
});
