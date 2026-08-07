/**
 * React hook for address quality validation (portable).
 *
 * This backend repo does not depend on React. In your Vite app:
 *
 *   import React from "react";
 *   import { createUseAddressValidator } from ".../hooks/useAddressValidator";
 *   import { validateAddress } from ".../validators/addressValidator";
 *   const useAddressValidator = createUseAddressValidator(React);
 *
 *   const { validation, validate, score, warnings } = useAddressValidator({
 *     mode: "local",
 *     validateLocal: validateAddress,
 *   });
 *
 * Or API mode: { mode: "api", apiUrl: "/api/order/validate-address", token }
 */

function createUseAddressValidator(React) {
  if (!React || typeof React.useState !== "function") {
    throw new Error(
      "createUseAddressValidator(React) requires the React namespace (useState/useCallback/useMemo).",
    );
  }
  const { useState, useCallback, useMemo } = React;

  return function useAddressValidator(options = {}) {
    const mode = options.mode || "local";
    const apiUrl = options.apiUrl || "/api/order/validate-address";
    const [validation, setValidation] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const validate = useCallback(
      async (input) => {
        setError(null);
        setLoading(true);
        try {
          let result;
          if (mode === "api") {
            const res = await fetch(apiUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(options.token ?
                  { Authorization: `Bearer ${options.token}` }
                : {}),
              },
              body: JSON.stringify(
                typeof input === "string" ? { address: input } : { ...input },
              ),
            });
            const json = await res.json();
            if (!res.ok) {
              throw new Error(
                json?.error || json?.message || "Validation failed",
              );
            }
            result = json.data || json.address_validation || json;
          } else {
            const validateLocal = options.validateLocal;
            if (typeof validateLocal !== "function") {
              throw new Error(
                "useAddressValidator local mode requires options.validateLocal (validateAddress)",
              );
            }
            result = validateLocal(input, { config: options.config });
          }
          setValidation(result);
          return result;
        } catch (err) {
          setError(err);
          setValidation(null);
          throw err;
        } finally {
          setLoading(false);
        }
      },
      [
        mode,
        apiUrl,
        options.token,
        options.validateLocal,
        options.config,
      ],
    );

    return useMemo(
      () => ({
        validation,
        validate,
        score: validation?.score ?? 0,
        warnings: validation?.warnings || [],
        confidence: validation?.confidence || null,
        isValid: validation?.isValid ?? null,
        loading,
        error,
      }),
      [validation, validate, loading, error],
    );
  };
}

module.exports = { createUseAddressValidator };
