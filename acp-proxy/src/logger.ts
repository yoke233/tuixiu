import pino from "pino";

export type LoggerFn = (msg: string, extra?: Record<string, unknown>) => void;

export function createLogger() {
  const level = process.env.LOG_LEVEL?.trim() ? process.env.LOG_LEVEL.trim() : "info";

  const pretty =
    process.env.LOG_PRETTY === "1" ||
    (process.env.NODE_ENV !== "production" && process.stdout.isTTY);

  const transport = pretty
    ? pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
          messageFormat: "{msg}",
        },
      })
    : undefined;

  return pino(
    {
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport,
  );
}

