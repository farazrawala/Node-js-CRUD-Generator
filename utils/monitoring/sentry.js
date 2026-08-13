const Sentry = require("@sentry/node");

function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    return { enabled: false, reason: "SENTRY_DSN not set" };
  }

  Sentry.init({
    dsn,
    environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 1),
    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
      Sentry.mongooseIntegration(),
    ],
  });

  return { enabled: true };
}

function captureException(err, context) {
  if (!process.env.SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    if (context) scope.setContext("extra", context);
    Sentry.captureException(err);
  });
}

function setupExpressErrorHandler(app) {
  if (!process.env.SENTRY_DSN) return;
  Sentry.setupExpressErrorHandler(app);
}

module.exports = {
  Sentry,
  initSentry,
  captureException,
  setupExpressErrorHandler,
};
