const pino = require("pino");
const pinoHttp = require("pino-http");
const { shouldSkipRequestLog } = require("./config");

function shouldUsePrettyLogs() {
  if (process.env.PINO_PRETTY === "false") return false;
  if (process.env.PINO_PRETTY === "true") return true;
  if (process.env.NODE_ENV === "production") return false;
  try {
    require.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

function createRequestLogger() {
  const level =
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === "production" ? "info" : "debug");

  const pinoOptions = { level };
  if (shouldUsePrettyLogs()) {
    pinoOptions.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    };
  }

  const logger = pino(pinoOptions);

  const middleware = pinoHttp({
    logger,
    autoLogging: {
      ignore: shouldSkipRequestLog,
    },
    genReqId(req) {
      return req.requestId;
    },
    customProps(req) {
      return req.requestId ? { requestId: req.requestId } : {};
    },
    customLogLevel(req, res, err) {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customSuccessMessage(req, res) {
      return `${req.method} ${req.url} ${res.statusCode}`;
    },
    customErrorMessage(req, res, err) {
      return `${req.method} ${req.url} failed — ${err?.message || res.statusCode}`;
    },
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress,
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  });

  return { logger, middleware };
}

module.exports = {
  createRequestLogger,
};
