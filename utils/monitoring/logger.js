const pino = require("pino");
const pinoHttp = require("pino-http");
const { shouldSkipRequestLog } = require("./config");

function createRequestLogger() {
  const level = process.env.LOG_LEVEL || "debug";

  const logger = pino({
    level,
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    },
  });

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
