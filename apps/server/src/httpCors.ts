export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
] as const;

// POC: hardcoded explicit origin so credentials-bearing requests work from
// the Mac mini tailnet endpoint. Replace with dynamic Origin echo when we
// wire proper deployment.
const allowedOrigin = process.env.T3CODE_CORS_ORIGIN?.trim() || "*";

export const browserApiCorsHeaders = {
  "access-control-allow-origin": allowedOrigin,
  ...(allowedOrigin === "*" ? {} : { "access-control-allow-credentials": "true" }),
  "access-control-allow-methods": browserApiCorsAllowedMethods.join(", "),
  "access-control-allow-headers": browserApiCorsAllowedHeaders.join(", "),
} as const;
